import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import compression from "compression";

const app = express();
app.use(compression());

const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  "http://localhost:3000",                // dev
  "https://www.norskglacierforecast.org", // prod
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST"],
}));

/* -----------------------------
   Frost config
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
const NVE_API_KEY = "ZaDBx37LJUS6vGmXpWYxDQ==";

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
    headers: { Accept: "application/json", "X-API-Key": NVE_API_KEY },
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

function sumPrecipitationHourly(frost) {
  let sum = 0;
  let unit = "mm";
  for (const row of frost?.data ?? []) {
    for (const ob of row.observations ?? []) {
      if (ob.elementId === "sum(precipitation_amount PT1H)") {
        sum += ob.value || 0;
        unit = ob.unit;
      }
    }
  }
  return {
    elementId: "sum(precipitation_amount P1D)",
    value: sum,
    unit,
    time: new Date().toISOString(),
  };
}

async function fetchLatestBatch(stationIds) {
  const endISO = new Date().toISOString();
  const start12h = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

  const url = new URL(`${FROST_BASE}/observations/v0.jsonld`);
  url.searchParams.set("sources", stationIds.join(","));
  url.searchParams.set("elements", "air_temperature");
  url.searchParams.set("referencetime", `${start12h}/${endISO}`);

  try {
    const frost = await frostJson(url.toString());
    const latestByStation = {};
    for (const row of frost?.data ?? []) {
      const station = row.sourceId;
      const ob = row.observations?.find((o) => o.elementId === "air_temperature");
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

app.get("/api/stations", async (_req, res) => {
  try {
    const cacheKey = "stations-with-latest-temp";
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    const url = `${FROST_BASE}/sources/v0.jsonld?types=SensorSystem`;
    const frost = await frostJson(url);
    const stations = frost?.data || [];

    const BATCH_SIZE = 50;
    const allLatest = {};
    for (let i = 0; i < stations.length; i += BATCH_SIZE) {
      const chunk = stations.slice(i, i + BATCH_SIZE).map((s) => s.id);
      const latest = await fetchLatestBatch(chunk);
      Object.assign(allLatest, latest);
    }

    const enrichedStations = stations.map((station) => ({
      ...station,
      latestTemperature: allLatest[station.id] || null,
    }));

    setCache(cacheKey, enrichedStations, 10 * 60);
    res.json(enrichedStations);
  } catch (e) {
    console.error("Stations error:", e.message);
    res.status(500).json({ error: "Failed to fetch stations" });
  }
});

app.get("/api/observations/:stationId", async (req, res) => {
  const stationId = req.params.stationId;
  const today = new Date();
  const start24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const endISO = today.toISOString();

  const requestedElements = (req.query.elements ||
    "air_temperature,wind_speed,wind_from_direction,relative_humidity,sum(precipitation_amount PT1H),snow_depth"
  ).split(",");

  try {
    const url = new URL(`${FROST_BASE}/observations/v0.jsonld`);
    url.searchParams.set("sources", stationId);
    url.searchParams.set("elements", requestedElements.join(","));
    url.searchParams.set("referencetime", `${start24h}/${endISO}`);

    const frost = await frostJson(url.toString());
    const latest = reduceLatest(frost);

    res.json({ stationId, latest });
  } catch (e) {
    console.error(`Observations error for ${stationId}:`, e.message);
    res.json({ stationId, latest: {} });
  }
});

/* -----------------------------
   NVE helpers
--------------------------------*/
async function nveStations() {
  const res = await nveJson(`${NVE_BASE}/Stations`);
  const data = res?.data ?? [];

  // 🟢 Normalize keys → always return lowercase stationId
  return data.map((s) => ({
    stationId: s.StationId || s.stationId,
    stationName: s.StationName || s.stationName,
    latitude: s.Latitude || s.latitude,
    longitude: s.Longitude || s.longitude,
    ...s, // keep all original fields just in case
  }));
}

function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

/**
 * Fetch observations from NVE HydAPI
 */
async function nveObservations(
  stationIds,
  parameters = "1001",
  resolutionTime = 0,
  referenceTime = null
) {
  if (!stationIds || stationIds.length === 0) return [];

  const paramStr = Array.isArray(parameters)
    ? parameters.join(",")
    : parameters;

  // ✅ Single station → GET
  if (stationIds.length === 1) {
    let url = `${NVE_BASE}/Observations?StationId=${encodeURIComponent(
      stationIds[0]
    )}&Parameter=${encodeURIComponent(paramStr)}&ResolutionTime=${resolutionTime}`;

    if (referenceTime) {
      url += `&ReferenceTime=${encodeURIComponent(referenceTime)}`;
    }

    const res = await nveJson(url);
    return res?.data ?? [];
  }

  // ✅ Multiple stations → batch POST requests
  const chunks = chunkArray(stationIds, 200);
  let allData = [];

  for (const chunk of chunks) {
    const payload = chunk.map((id) => ({
      StationId: id, // NVE HydAPI expects uppercase
      Parameter: paramStr,
      ResolutionTime: resolutionTime,
      ...(referenceTime ? { ReferenceTime: referenceTime } : {}),
    }));

    const res = await nveJson(`${NVE_BASE}/Observations`, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });

    if (res?.data) {
      allData = allData.concat(res.data);
    }
  }

  return allData;
}

/* -----------------------------
   NVE Routes
--------------------------------*/

// ✅ NVE Stations (cached for 1h)
app.get("/api/nve/stations", async (_req, res) => {
  try {
    const cacheKey = "nve-stations";
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    const data = await nveStations();
    setCache(cacheKey, data, 60 * 60); // cache for 1h
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

// ✅ NVE Observations (decides GET vs POST)
app.get("/api/nve/observations", async (req, res) => {
  try {
    const stationId = req.query.stationId;
    const parameter = req.query.parameter || "1001";
    const resolutionTime = parseInt(req.query.resolutionTime || "0", 10);
    const referenceTime = req.query.referenceTime || null;

    if (!stationId) {
      return res.status(400).json({ error: "stationId query required" });
    }

    const ids = stationId.split(",").filter((id) => id.trim() !== "");

    console.log(
      `🔎 /api/nve/observations → ${ids.length} stations, parameter=${parameter}, resTime=${resolutionTime}, ref=${referenceTime}`
    );

    const obs = await nveObservations(ids, parameter, resolutionTime, referenceTime);
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

// ✅ NVE Latest (all stations for given parameter)
app.get("/api/nve/latest", async (req, res) => {
  try {
    const parameter = req.query.parameter || "1001";
    const resolutionTime = parseInt(req.query.resolutionTime || "0", 10);
    const referenceTime = req.query.referenceTime || null;

    // pull cached stations or fetch fresh
    const cacheKey = "nve-stations";
    let stations = getCache(cacheKey);
    if (!stations) {
      stations = await nveStations();
      setCache(cacheKey, stations, 60 * 60);
    }

    const ids = stations
      .map((s) => s.stationId) // normalized by nveStations()
      .filter((id) => id != null && String(id).trim() !== "");

    console.log(`🔎 /api/nve/latest → ${ids.length} stations`);

    if (ids.length === 0) {
      return res.status(500).json({ error: "No valid station IDs found" });
    }

    const obs = await nveObservations(ids, parameter, resolutionTime, referenceTime);
    res.json(obs);
  } catch (e) {
    console.error("NVE latest error:", e.message);
    res.status(500).json({ error: "Failed to fetch NVE latest observations" });
  }
});

/* -----------------------------
   Start server
--------------------------------*/
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
