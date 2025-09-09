// server.js
// Node >=18 (or add a fetch polyfill). Using ESM: set `"type": "module"` in package.json.

import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;
const FROST_BASE = "https://frost.met.no";

// Feature flag to disable all normals calls (temporary)
const DISABLE_NORMALS = true; // set to false to re-enable normals later

// ❗ Frost credentials (hardcoded by request)
const FROST_CLIENT_ID = "12f68031-8ce7-48c7-bc7a-38b843f53711";
const FROST_CLIENT_SECRET = "08a75b8d-ca70-44a9-807d-d79421c082bf";

// Build Basic Auth header
const frostAuthHeader = () =>
  "Basic " + Buffer.from(`${FROST_CLIENT_ID}:${FROST_CLIENT_SECRET}`).toString("base64");

/* -----------------------------
   Tiny in-memory cache
--------------------------------*/
const cache = new Map(); // key -> { t, ttlMs, data }
const getCache = (key) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > hit.ttlMs) {
    cache.delete(key);
    return null;
  }
  return hit.data;
};
const setCache = (key, data, ttlSec) => {
  cache.set(key, { t: Date.now(), ttlMs: ttlSec * 1000, data });
};

/* -----------------------------
   Helpers
--------------------------------*/
async function frostJson(url) {
  const r = await fetch(url, {
    headers: { Authorization: frostAuthHeader(), Accept: "application/json" },
    timeout: 15000,
  });
  if (!r.ok) {
    const text = await r.text();
    const err = new Error(`Frost ${r.status}: ${text}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

function reduceLatest(frost) {
  const latest = {};
  for (const row of frost?.data ?? []) {
    for (const ob of row.observations ?? []) {
      const { elementId, value, unit, time } = ob;
      if (!latest[elementId] || new Date(time) > new Date(latest[elementId].time)) {
        latest[elementId] = { value, unit, time };
      }
    }
  }
  return latest;
}

function toSeries(frost) {
  const series = {};
  for (const row of frost?.data ?? []) {
    for (const ob of row.observations ?? []) {
      const { elementId, value, unit, time } = ob;
      (series[elementId] ||= []).push({ time, value, unit });
    }
  }
  for (const k of Object.keys(series)) {
    series[k].sort((a, b) => new Date(a.time) - new Date(b.time));
  }
  return series;
}

function splitIntervals(startISO, endISO, chunkDays = 7) {
  const out = [];
  let cur = new Date(startISO + "T00:00:00Z");
  const end = new Date(endISO + "T00:00:00Z");
  while (cur < end) {
    const next = new Date(cur);
    next.setUTCDate(next.getUTCDate() + chunkDays);
    const to = next < end ? next : end;
    out.push([cur.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);
    cur = to;
  }
  return out;
}

// Parse a "YYYY/YYYY" period string and return end year (number). Unknown -> -Infinity
function periodEndYear(periodStr) {
  if (!periodStr || !/^\d{4}\/\d{4}$/.test(periodStr)) return -Infinity;
  return Number(periodStr.split("/")[1]);
}

// Pick the newest available period for a station + elements list
async function getPreferredNormalsPeriod(stationId, elementsCsv) {
  const cacheKey = `normals-available|${stationId}|${elementsCsv}`;
  let avail = getCache(cacheKey);
  if (!avail) {
    const url = new URL(`${FROST_BASE}/climatenormals/available/v0.jsonld`);
    url.searchParams.set("sources", stationId);
    url.searchParams.set("elements", elementsCsv || "*");
    avail = await frostJson(url.toString());
    setCache(cacheKey, avail, 6 * 60 * 60); // 6h
  }

  // Collect all period strings in availability response
  const periods = new Set();
  for (const row of avail?.data ?? []) {
    if (row?.period) periods.add(row.period);
  }
  if (periods.size === 0) return null;

  // Choose the one with the largest end year
  const sorted = [...periods].sort((a, b) => periodEndYear(b) - periodEndYear(a));
  return sorted[0] || null;
}

/* -----------------------------
   Routes
--------------------------------*/

// Health
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// 1) Stations
app.get("/api/stations", async (_req, res) => {
  try {
    const cacheKey = "stations";
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    const url = `${FROST_BASE}/sources/v0.jsonld?types=SensorSystem`;
    const frost = await frostJson(url);
    if (!Array.isArray(frost?.data)) {
      return res.status(502).json({ error: "Invalid Frost stations response" });
    }

    setCache(cacheKey, frost.data, 3600);
    res.json(frost.data);
  } catch (e) {
    console.error("Stations error:", e.message);
    res.status(e.status || 500).json({ error: "Failed to fetch stations" });
  }
});

// 2) Latest observations (robust, never surfaces 4xx to client)
app.get("/api/observations/:stationId", async (req, res) => {
  const stationId = req.params.stationId;
  const elementsParam =
    req.query.elements ||
    "air_temperature,wind_speed,wind_from_direction,relative_humidity,precipitation_amount,snow_depth";
  const sinceParam = req.query.since || "now-6h/now";

  const cacheKey = `latest|${stationId}|${elementsParam}|${sinceParam}`;
  const hit = getCache(cacheKey);
  if (hit) return res.json(hit);

  async function frostObs(elements, since) {
    const url = new URL(`${FROST_BASE}/observations/v0.jsonld`);
    url.searchParams.set("sources", stationId);
    url.searchParams.set("elements", elements);
    url.searchParams.set("referencetime", since);
    return frostJson(url.toString());
  }

  try {
    let frost;
    // 1) as requested (full element set, 6h)
    try {
      frost = await frostObs(elementsParam, sinceParam);
    } catch (e1) {
      // 2) fallback: minimal elements, wider window
      try {
        frost = await frostObs("air_temperature,precipitation_amount", "now-24h/now");
      } catch (e2) {
        // 3) give up gracefully: empty payload so UI shows placeholders
        const payload = {
          stationId,
          elements: elementsParam.split(","),
          window: sinceParam,
          latest: {},
          note: "no observations matched; returned empty latest instead of error",
        };
        setCache(cacheKey, payload, 30);
        return res.json(payload);
      }
    }

    const latest = reduceLatest(frost);
    const payload = { stationId, elements: elementsParam.split(","), window: sinceParam, latest };
    setCache(cacheKey, payload, 60);
    res.json(payload);
  } catch (e) {
    console.error("Latest obs error (final):", e.message);
    // Defensive: return empty payload instead of 4xx/5xx
    res.json({ stationId, elements: elementsParam.split(","), window: sinceParam, latest: {} });
  }
});

app.get("/api/observations/available/:stationId", async (req, res) => {
  try {
    const { stationId } = req.params;
    const elements = req.query.elements || "*";
    const referencetime = req.query.referencetime || "now-24h/now";

    const cacheKey = `obs-available|${stationId}|${elements}|${referencetime}`;
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    const url = new URL(`${FROST_BASE}/observations/available/v0.jsonld`);
    url.searchParams.set("sources", stationId);
    url.searchParams.set("elements", elements);
    url.searchParams.set("referencetime", referencetime);

    const frost = await frostJson(url.toString());
    setCache(cacheKey, frost, 30 * 60); // 30 min
    res.json(frost);
  } catch (e) {
    console.error("Obs available error:", e.message);
    res
      .status(e.status || 500)
      .json({ error: "Observations availability failed" });
  }
});

// 3) Historical data
app.get("/api/history/:stationId", async (req, res) => {
  try {
    const stationId = req.params.stationId;
    const elementsParam =
      req.query.elements ||
      "air_temperature,wind_speed,wind_from_direction,relative_humidity,precipitation_amount,snow_depth";
    const start = req.query.start;
    const end = req.query.end;
    const chunkDays = Math.max(1, Number(req.query.chunkDays || 7));
    const limit = Number(req.query.limit || 10000);

    if (!start || !end) {
      return res.status(400).json({ error: "Missing start or end (YYYY-MM-DD)" });
    }

    const cacheKey = `hist|${stationId}|${elementsParam}|${start}|${end}|${chunkDays}`;
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    const elements = elementsParam.split(",");
    const intervals = splitIntervals(start, end, chunkDays);
    const merged = {};
    for (const el of elements) merged[el] = [];

    for (const [s, e] of intervals) {
      const url = new URL(`${FROST_BASE}/observations/v0.jsonld`);
      url.searchParams.set("sources", stationId);
      url.searchParams.set("elements", elementsParam);
      url.searchParams.set("referencetime", `${s}/${e}`);
      url.searchParams.set("limit", String(limit));

      const frost = await frostJson(url.toString());
      const series = toSeries(frost);
      for (const el of Object.keys(series)) merged[el].push(...series[el]);

      // polite delay for rate limits
      await new Promise((r) => setTimeout(r, 200));
    }

    // Deduplicate timestamps and sort
    for (const k of Object.keys(merged)) {
      const seen = new Set();
      merged[k] = merged[k]
        .filter((p) => !seen.has(p.time) && seen.add(p.time))
        .sort((a, b) => new Date(a.time) - new Date(b.time));
    }

    const payload = { stationId, elements, start, end, chunkDays, series: merged };
    setCache(cacheKey, payload, 600);
    res.json(payload);
  } catch (e) {
    console.error("History error:", e.message);
    res.status(e.status || 500).json({ error: "History fetch failed" });
  }
});

// 4A) Normals availability passthrough (optional) — disabled via flag
app.get("/api/normals/available/:stationId", async (req, res) => {
  try {
    if (DISABLE_NORMALS) {
      // return empty availability so UI can gracefully hide normals
      return res.json({ data: [], note: "normals disabled" });
    }

    const { stationId } = req.params;
    const elements = req.query.elements || "*";

    const cacheKey = `normals-available|${stationId}|${elements}`;
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    const url = new URL(`${FROST_BASE}/climatenormals/available/v0.jsonld`);
    url.searchParams.set("sources", stationId);
    url.searchParams.set("elements", elements);

    const frost = await frostJson(url.toString());
    setCache(cacheKey, frost, 6 * 60 * 60); // 6h
    res.json(frost);
  } catch (e) {
    console.error("Normals available error:", e.message);
    res.status(e.status || 500).json({ error: "Normals availability failed" });
  }
});

// 4B) Normals data with AUTO period selection (prefers newest baseline) — disabled via flag
app.get("/api/normals/:stationId", async (req, res) => {
  try {
    if (DISABLE_NORMALS) {
      const { stationId } = req.params;
      const elements = (req.query.elements || "").split(",").filter(Boolean);
      return res.json({
        stationId,
        period: null,
        elements,
        rows: {}, // elementId -> []
        rawCount: 0,
        note: "normals disabled",
      });
    }

    const { stationId } = req.params;
    const elements = req.query.elements; // REQUIRED
    let { period } = req.query;          // Optional now (auto if missing)
    const months = req.query.months;     // optional
    const days = req.query.days;         // optional

    if (!elements) {
      return res.status(400).json({ error: "Missing elements" });
    }

    // If period not provided, pick the newest available baseline automatically
    if (!period) {
      period = await getPreferredNormalsPeriod(stationId, elements);
      if (!period) {
        return res.status(404).json({ error: "No normals period available for this station/elements" });
      }
    }

    const cacheKey = `normals|${stationId}|${elements}|${period}|${months||""}|${days||""}`;
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    const url = new URL(`${FROST_BASE}/climatenormals/v0.jsonld`);
    url.searchParams.set("sources", stationId);
    url.searchParams.set("elements", elements);
    url.searchParams.set("period", period);
    if (months) url.searchParams.set("months", months);
    if (days) url.searchParams.set("days", days);

    const frost = await frostJson(url.toString());

    // Normalize rows by element
    const byElement = {};
    for (const row of frost?.data ?? []) {
      const { elementId, month, day, normal } = row;
      (byElement[elementId] ||= []).push({
        month: month != null ? Number(month) : null,
        day: day != null ? Number(day) : null,
        normal: normal != null ? Number(normal) : null,
      });
    }
    for (const k of Object.keys(byElement)) {
      byElement[k].sort(
        (a, b) =>
          (a.month ?? 0) - (b.month ?? 0) ||
          (a.day ?? 0) - (b.day ?? 0)
      );
    }

    const payload = {
      stationId,
      period, // resolved (auto or provided)
      elements: elements.split(","),
      rows: byElement,
      rawCount: frost?.currentItemCount ?? (frost?.data?.length || 0),
    };

    setCache(cacheKey, payload, 24 * 60 * 60); // 24h
    res.json(payload);
  } catch (e) {
    console.error("Normals error:", e.message);
    res.status(e.status || 500).json({ error: "Normals fetch failed" });
  }
});

/* -----------------------------
   Start server
--------------------------------*/
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
