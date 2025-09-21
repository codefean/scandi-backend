// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import compression from "compression";

const app = express();
app.use(cors());
app.use(compression());

const PORT = process.env.PORT || 3001;

/* -----------------------------
   Frost config
--------------------------------*/
const FROST_BASE = "https://frost.met.no";
const FROST_CLIENT_ID =
  process.env.FROST_CLIENT_ID || "12f68031-8ce7-48c7-bc7a-38b843f53711";
const FROST_CLIENT_SECRET =
  process.env.FROST_CLIENT_SECRET || "08a75b8d-ca70-44a9-807d-d79421c082bf";

const frostAuthHeader = () =>
  "Basic " +
  Buffer.from(`${FROST_CLIENT_ID}:${FROST_CLIENT_SECRET}`).toString("base64");

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
   Fetch wrapper
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

/* -----------------------------
   Frost helpers
--------------------------------*/
function reduceLatest(frost) {
  const latest = {};
  for (const row of frost?.data ?? []) {
    for (const ob of row.observations ?? []) {
      const { elementId, value, unit } = ob;
      const obsTime = ob.time || row.referenceTime;
      if (
        !latest[elementId] ||
        new Date(obsTime) > new Date(latest[elementId].time)
      ) {
        latest[elementId] = { value, unit, time: obsTime };
      }
    }
  }
  return latest;
}

async function fetchLatestBatch(stationIds) {
  const url = new URL(`${FROST_BASE}/observations/v0.jsonld`);
  url.searchParams.set("sources", stationIds.join(","));
  url.searchParams.set("elements", "air_temperature");
  url.searchParams.set("referencetime", "latest"); // ✅ only latest obs

  try {
    const frost = await frostJson(url.toString());
    const latestByStation = {};
    for (const row of frost?.data ?? []) {
      const station = row.sourceId;
      const ob = row.observations?.find(
        (o) => o.elementId === "air_temperature"
      );
      if (ob) {
        latestByStation[station] = {
          value: ob.value,
          unit: ob.unit,
          time: ob.time,
        };
      }
    }
    return latestByStation;
  } catch (e) {
    console.error("Batch temperature fetch failed:", e.message);
    return {};
  }
}

/* -----------------------------
   Frost Routes
--------------------------------*/

// ✅ Stations (with cached latest temps)
app.get("/api/stations", async (_req, res) => {
  try {
    const cacheKey = "stations-with-latest-temp";
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    // fetch stations list (cache 2h)
    let stations = getCache("stations");
    if (!stations) {
      const frost = await frostJson(
        `${FROST_BASE}/sources/v0.jsonld?types=SensorSystem`
      );
      stations = frost?.data || [];
      setCache("stations", stations, 2 * 60 * 60); // 2h cache
    }

    // fetch latest temps in parallel (cache 5m)
    const BATCH_SIZE = 50;
    const chunks = [];
    for (let i = 0; i < stations.length; i += BATCH_SIZE) {
      chunks.push(stations.slice(i, i + BATCH_SIZE).map((s) => s.id));
    }

    const results = await Promise.all(chunks.map(fetchLatestBatch));
    const allLatest = results.reduce(
      (acc, latest) => Object.assign(acc, latest),
      {}
    );

    const enrichedStations = stations.map((station) => ({
      ...station,
      latestTemperature: allLatest[station.id] || null,
    }));

    setCache(cacheKey, enrichedStations, 5 * 60); // 5m cache
    res.json(enrichedStations);
  } catch (e) {
    console.error("Stations error:", e.message);
    res.status(500).json({ error: "Failed to fetch stations" });
  }
});

// ✅ Observations (latest only by default, or full 24h if requested)
app.get("/api/observations/:stationId", async (req, res) => {
  const stationId = req.params.stationId;
  const requestedElements = (
    req.query.elements ||
    "air_temperature,wind_speed,wind_from_direction,relative_humidity,sum(precipitation_amount PT1H),snow_depth"
  ).split(",");

  try {
    const url = new URL(`${FROST_BASE}/observations/v0.jsonld`);
    url.searchParams.set("sources", stationId);
    url.searchParams.set("elements", requestedElements.join(","));

    if (req.query.range === "24h") {
      const endISO = new Date().toISOString();
      const start24h = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      ).toISOString();
      url.searchParams.set("referencetime", `${start24h}/${endISO}`);
    } else {
      url.searchParams.set("referencetime", "latest"); 
    }

    const frost = await frostJson(url.toString());
    const latest = reduceLatest(frost);

    res.json({ stationId, latest });
  } catch (e) {
    console.error(`Observations error for ${stationId}:`, e.message);
    res.json({ stationId, latest: {} });
  }
});

/* -----------------------------
   Start Frost server
--------------------------------*/
app.listen(PORT, () => {
  console.log(`✅ Frost server running on http://localhost:${PORT}`);
});
