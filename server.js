import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import compression from "compression";

const app = express();
app.use(cors());
app.use(compression());

const PORT = process.env.PORT || 3001;
const FROST_BASE = "https://frost.met.no";

// ❗ Hardcoded Frost credentials
const FROST_CLIENT_ID = "12f68031-8ce7-48c7-bc7a-38b843f53711";
const FROST_CLIENT_SECRET = "08a75b8d-ca70-44a9-807d-d79421c082bf";
const frostAuthHeader = () =>
  "Basic " + Buffer.from(`${FROST_CLIENT_ID}:${FROST_CLIENT_SECRET}`).toString("base64");

/* -----------------------------
   In-memory cache
--------------------------------*/
const cache = new Map();
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
   Frost fetch wrapper with debugging
--------------------------------*/
async function frostJson(url) {
  const start = Date.now();
  const r = await fetch(url, {
    headers: { Authorization: frostAuthHeader(), Accept: "application/json" },
    timeout: 15000,
  });
  const elapsed = Date.now() - start;
  console.log(`⏱️ Frost fetch: ${url} (${elapsed} ms)`);

  if (!r.ok) {
    const text = await r.text();
    console.error(`[FROST DEBUG] Failed request: ${url}`);
    console.error(`[FROST DEBUG] Response: ${text}`);

    // Gracefully handle 412: No available timeseries for station/element
    if (r.status === 412) {
      return { data: [], warning: "No data available for this station and parameters" };
    }

    const err = new Error(`Frost ${r.status}: ${text}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/* -----------------------------
   Validation & Debugging Utils
--------------------------------*/
function assertValidFrostData(context, frost, requiredFields = ["data"]) {
  if (!frost || typeof frost !== "object") {
    throw new Error(`${context}: Frost response is not an object`);
  }
  for (const field of requiredFields) {
    if (!(field in frost)) {
      throw new Error(`${context}: Missing field "${field}"`);
    }
  }
  if (!Array.isArray(frost.data)) {
    throw new Error(`${context}: Expected "data" to be an array`);
  }
}

function logFrostSummary(context, frost) {
  console.log(
    `🔍 ${context}: received ${
      Array.isArray(frost?.data) ? frost.data.length : 0
    } rows`
  );
}

/* -----------------------------
   Relative → Absolute Range Converter
--------------------------------*/
function toAbsoluteRange(range) {
  if (!range.startsWith("now-")) return range; // Already ISO or fixed range
  const match = range.match(/^now-(\d+)([hdm])\/now$/);
  if (!match) return range;

  const amount = parseInt(match[1], 10);
  const unit = match[2];

  const now = new Date();
  const end = now.toISOString();
  const start = new Date(now);

  if (unit === "h") start.setHours(now.getHours() - amount);
  else if (unit === "d") start.setDate(now.getDate() - amount);
  else if (unit === "m") start.setMinutes(now.getMinutes() - amount);

  return `${start.toISOString()}/${end}`;
}

/* -----------------------------
   Helpers
--------------------------------*/
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

function splitIntervals(startDate, endDate, chunkDays) {
  const intervals = [];
  let start = new Date(startDate);
  const end = new Date(endDate);

  while (start < end) {
    const chunkEnd = new Date(start);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    intervals.push([start.toISOString(), chunkEnd.toISOString()]);
    start = chunkEnd;
  }

  return intervals;
}

/* -----------------------------
   Routes
--------------------------------*/

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ✅ 1) Stations
app.get("/api/stations", async (_req, res) => {
  try {
    const cacheKey = "stations";
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    const url = `${FROST_BASE}/sources/v0.jsonld?types=SensorSystem`;
    const frost = await frostJson(url);
    assertValidFrostData("Stations", frost);
    logFrostSummary("Stations", frost);

    setCache(cacheKey, frost.data, 6 * 60 * 60);
    res.json(frost.data);
  } catch (e) {
    console.error("Stations error:", e.message);
    res.status(e.status || 500).json({ error: "Failed to fetch stations" });
  }
});

// ✅ 2) Latest observations
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
    url.searchParams.set("referencetime", toAbsoluteRange(since));
    return frostJson(url.toString());
  }

  try {
    let frost = await frostObs(elementsParam, sinceParam);

    // Handle no data gracefully
    if (!frost.data?.length) {
      console.warn(`⚠️ No observations available for ${stationId} (${elementsParam})`);
      return res.json({
        stationId,
        elements: elementsParam.split(","),
        window: sinceParam,
        latest: {},
        warning: "No data available"
      });
    }

    assertValidFrostData("Latest Observations", frost);
    logFrostSummary("Latest Observations", frost);

    const latest = reduceLatest(frost);
    const payload = { stationId, elements: elementsParam.split(","), window: sinceParam, latest };
    setCache(cacheKey, payload, 300);
    res.json(payload);
  } catch (e) {
    console.error("Observations error:", e.message);
    res.json({ stationId, elements: elementsParam.split(","), window: sinceParam, latest: {} });
  }
});

// ✅ 3) Historical data
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

    const promises = intervals.map(([s, e]) =>
      (async () => {
        const url = new URL(`${FROST_BASE}/observations/v0.jsonld`);
        url.searchParams.set("sources", stationId);
        url.searchParams.set("elements", elementsParam);
        url.searchParams.set("referencetime", `${s}/${e}`);
        url.searchParams.set("limit", String(limit));

        const frost = await frostJson(url.toString());

        if (!frost.data?.length) {
          console.warn(`⚠️ No historical data for ${stationId} between ${s} and ${e}`);
          return;
        }

        assertValidFrostData(`History chunk ${s}/${e}`, frost);
        logFrostSummary(`History chunk ${s}/${e}`, frost);

        const series = toSeries(frost);
        for (const el of Object.keys(series)) merged[el].push(...series[el]);
      })()
    );

    await Promise.all(promises);

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

/* -----------------------------
   NEW: Debug endpoint
--------------------------------*/
app.get("/api/debug/:stationId", async (req, res) => {
  try {
    const { stationId } = req.params;

    const availableURL = `${FROST_BASE}/observations/availableTimeSeries/v0.jsonld?sources=${stationId}`;
    const latestURL = `${FROST_BASE}/observations/v0.jsonld?sources=${stationId}&referencetime=${toAbsoluteRange("now-6h/now")}`;
    const historyURL = `${FROST_BASE}/observations/v0.jsonld?sources=${stationId}&referencetime=${toAbsoluteRange("now-7d/now")}`;

    const [available, latest, history] = await Promise.all([
      frostJson(availableURL),
      frostJson(latestURL),
      frostJson(historyURL),
    ]);

    res.json({
      stationId,
      availableElements: available?.data ?? [],
      latest: latest?.data ?? [],
      history: history?.data ?? [],
    });
  } catch (e) {
    console.error("Debug endpoint error:", e.message);
    res.status(e.status || 500).json({ error: "Debug fetch failed" });
  }
});

/* -----------------------------
   Start server
--------------------------------*/
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
