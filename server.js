// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import compression from "compression";

const app = express();
app.use(cors());
app.use(compression());

const PORT = process.env.PORT || 3001;
const FROST_BASE = "https://frost.met.no";

// ❗ Hardcoded Frost credentials (per your request)
const FROST_CLIENT_ID = "12f68031-8ce7-48c7-bc7a-38b843f53711";
const FROST_CLIENT_SECRET = "08a75b8d-ca70-44a9-807d-d79421c082bf";
const frostAuthHeader = () =>
  "Basic " + Buffer.from(`${FROST_CLIENT_ID}:${FROST_CLIENT_SECRET}`).toString("base64");

/* -----------------------------
   In-memory cache (optimized)
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
   Fetch wrapper with timings
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
    const err = new Error(`Frost ${r.status}: ${text}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
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

/* -----------------------------
   Routes
--------------------------------*/

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ✅ 1) Stations (weather stations list)
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

    setCache(cacheKey, frost.data, 6 * 60 * 60); // cache 6 hours
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
    url.searchParams.set("referencetime", since);
    return frostJson(url.toString());
  }

  try {
    let frost = await frostObs(elementsParam, sinceParam);
    const latest = reduceLatest(frost);
    const payload = { stationId, elements: elementsParam.split(","), window: sinceParam, latest };
    setCache(cacheKey, payload, 300); // cache 5 min
    res.json(payload);
  } catch (e) {
    console.error("Observations error:", e.message);
    res.json({ stationId, elements: elementsParam.split(","), window: sinceParam, latest: {} });
  }
});

// ✅ 3) Climate normals (new endpoint!)
app.get("/api/climatenormals", async (req, res) => {
  try {
    const { stationId, elements, period, months, days, offset } = req.query;

    if (!stationId || !elements) {
      return res.status(400).json({ error: "Missing stationId or elements" });
    }

    const cacheKey = `climatenormals|${stationId}|${elements}|${period||""}|${months||""}|${days||""}|${offset||0}`;
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    const url = new URL(`${FROST_BASE}/climatenormals/v0.jsonld`);
    url.searchParams.set("sources", stationId);
    url.searchParams.set("elements", elements);
    if (period) url.searchParams.set("period", period);
    if (months) url.searchParams.set("months", months);
    if (days) url.searchParams.set("days", days);
    if (offset) url.searchParams.set("offset", offset);

    const frost = await frostJson(url.toString());
    setCache(cacheKey, frost, 24 * 60 * 60); // cache 24 hours
    res.json(frost);
  } catch (e) {
    console.error("Climate normals error:", e.message);
    res.status(e.status || 500).json({ error: "Failed to fetch climate normals" });
  }
});

/* -----------------------------
   Start server
--------------------------------*/
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
