import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import compression from "compression";

const app = express();
app.use(cors());
app.use(compression());

const PORT = process.env.PORT || 3001;

/* -----------------------------
   Frost API config
--------------------------------*/
const FROST_BASE = "https://frost.met.no";
const FROST_CLIENT_ID = "12f68031-8ce7-48c7-bc7a-38b843f53711";
const FROST_CLIENT_SECRET = "08a75b8d-ca70-44a9-807d-d79421c082bf";
const frostAuthHeader = () =>
  "Basic " +
  Buffer.from(`${FROST_CLIENT_ID}:${FROST_CLIENT_SECRET}`).toString("base64");

/* -----------------------------
   NVE HydAPI config
--------------------------------*/
const NVE_BASE = "https://hydapi.nve.no/api/v1";
const NVE_API_KEY = "ZaDBx37LJUS6vGmXpWYxDQ=="; // 🔑 Hardcoded for now

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
   Fetch wrappers
--------------------------------*/
async function frostJson(url) {
  const start = Date.now();
  const r = await fetch(url, {
    headers: { Authorization: frostAuthHeader(), Accept: "application/json" },
  });
  const elapsed = Date.now() - start;
  console.log(`⏱️ Frost fetch: ${url} (${elapsed} ms)`);

  if (!r.ok) {
    const text = await r.text();
    console.error(`[FROST DEBUG] Failed request: ${url}`);
    console.error(`[FROST DEBUG] Response: ${text}`);
    if (r.status === 412) {
      return { data: [], warning: "No data available" };
    }
    throw new Error(`Frost ${r.status}: ${text}`);
  }
  return r.json();
}

async function nveJson(url, options = {}) {
  const start = Date.now();
  const r = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-API-Key": NVE_API_KEY, // 🔑 Required for HydAPI
      ...(options.headers || {}),
    },
    ...options,
  });
  const elapsed = Date.now() - start;
  console.log(`⏱️ NVE fetch: ${url} (${elapsed} ms)`);

  if (!r.ok) {
    const text = await r.text();
    console.error(`[NVE DEBUG] Failed request: ${url}`);
    console.error(`[NVE DEBUG] Response: ${text}`);
    throw new Error(`NVE ${r.status}: ${text}`);
  }
  return r.json();
}

/* -----------------------------
   NVE helpers
--------------------------------*/
async function nveStations() {
  const res = await nveJson(`${NVE_BASE}/Stations`);
  return res?.data ?? [];
}

async function nveObservations(stationIds, parameter = "1001") {
  if (!stationIds || stationIds.length === 0) return [];

  // ✅ Single station → use GET
  if (stationIds.length === 1) {
    const url = `${NVE_BASE}/Observations?StationId=${encodeURIComponent(
      stationIds[0]
    )}&Parameter=${parameter}`;
    const res = await nveJson(url);
    return res?.data ?? [];
  }

  // ✅ Multiple stations → use POST
  const payload = stationIds.map((id) => ({
    StationId: id,
    Parameter: parameter,
    ResolutionTime: "latest",
  }));

  const res = await nveJson(`${NVE_BASE}/Observations`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });

  return res?.data ?? [];
}

/* -----------------------------
   Routes
--------------------------------*/
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ✅ NVE Stations
app.get("/api/nve/stations", async (_req, res) => {
  try {
    const data = await nveStations();
    res.json(data);
  } catch (e) {
    console.error("NVE stations error:", e.message);
    res.status(500).json({ error: "Failed to fetch NVE stations" });
  }
});

// ✅ NVE Single Station
app.get("/api/nve/stations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const data = await nveJson(`${NVE_BASE}/Stations/${encodeURIComponent(id)}`);
    res.json(data);
  } catch (e) {
    console.error("NVE single station error:", e.message);
    res.status(500).json({ error: "Failed to fetch NVE station" });
  }
});

// ✅ NVE Observations (supports single + multiple stations)
app.get("/api/nve/observations", async (req, res) => {
  try {
    const stationId = req.query.stationId;
    const parameter = req.query.parameter || "1001";
    if (!stationId) {
      return res.status(400).json({ error: "stationId query required" });
    }
    const ids = stationId.split(",");
    const obs = await nveObservations(ids, parameter);
    res.json(obs);
  } catch (e) {
    console.error("NVE observations error:", e.message);
    res.status(500).json({ error: "Failed to fetch NVE observations" });
  }
});

// ✅ NVE Parameters
app.get("/api/nve/parameters", async (_req, res) => {
  try {
    const data = await nveJson(`${NVE_BASE}/Parameters`);
    res.json(data?.data ?? []);
  } catch (e) {
    console.error("NVE parameters error:", e.message);
    res.status(500).json({ error: "Failed to fetch NVE parameters" });
  }
});

/* -----------------------------
   Start server
--------------------------------*/
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
