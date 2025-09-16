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
   NVE HydAPI config (hardcoded key)
--------------------------------*/
const NVE_BASE = "https://hydapi.nve.no/api/v1";
const NVE_API_KEY = "ZaDBx37LJUS6vGmXpWYxDQ=="; // 🔑 Hardcoded

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
      Authorization: `Bearer ${NVE_API_KEY}`, // ✅ Always attach key
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
  try {
    const res = await nveJson(`${NVE_BASE}/Stations?Active=true`);
    return res?.data ?? [];
  } catch (err) {
    console.warn("nveStations() failed, retrying without filter:", err.message);
    const res = await nveJson(`${NVE_BASE}/Stations`);
    return res?.data ?? [];
  }
}

async function nveLatestObservations(stationIds, parameter = "1001") {
  const url = `${NVE_BASE}/Observations`;
  const payload = {
    StationId: stationIds,
    Parameter: parameter,
    ResolutionTime: "latest",
  };
  const res = await nveJson(url, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
  return res?.data ?? [];
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
    let frost = await frostJson(url.toString());
    let latestByStation = {};

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
   Prewarm caches
--------------------------------*/
async function refreshNveCache(parameter = "1001") {
  try {
    const stations = await nveStations();
    const stationIds = stations.map((s) => s.Id);

    let allObs = [];
    const chunkSize = 50;
    for (let i = 0; i < stationIds.length; i += chunkSize) {
      const chunk = stationIds.slice(i, i + chunkSize);
      const obs = await nveLatestObservations(chunk, parameter);
      allObs = allObs.concat(obs);
    }

    const merged = allObs.map((obs) => {
      const st = stations.find((s) => s.Id === obs.StationId);
      return {
        stationId: obs.StationId,
        name: st?.Name,
        lat: st?.Latitude,
        lon: st?.Longitude,
        value: obs.Value,
        time: obs.Time,
        parameter,
      };
    });

    setCache(`nve-latest-${parameter}`, merged, 10 * 60);
    console.log(`✅ Pre-warmed NVE cache for parameter ${parameter}`);
  } catch (e) {
    console.error("NVE prewarm error:", e.message);
  }
}

/* -----------------------------
   Routes
--------------------------------*/
app.get("/api/nve/latest", async (req, res) => {
  try {
    const parameter = req.query.parameter || "1001";
    const cacheKey = `nve-latest-${parameter}`;
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    await refreshNveCache(parameter);
    res.json(getCache(cacheKey) || []);
  } catch (e) {
    console.error("NVE latest error:", e.message);
    res.status(500).json({ error: "Failed to fetch NVE data" });
  }
});

app.get("/api/nve/parameters", async (_req, res) => {
  try {
    const data = await nveJson(`${NVE_BASE}/Parameters`);
    res.json(data?.data ?? []);
  } catch (e) {
    console.error("NVE parameters error:", e.message);
    res.status(500).json({ error: "Failed to fetch NVE parameters" });
  }
});

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

/* -----------------------------
   Start server
--------------------------------*/
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
