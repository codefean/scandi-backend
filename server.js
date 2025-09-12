import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import compression from "compression";

const app = express();
app.use(cors());
app.use(compression());

const PORT = process.env.PORT || 3001;
const FROST_BASE = "https://frost.met.no";

// ❗ Frost credentials
const FROST_CLIENT_ID = "12f68031-8ce7-48c7-bc7a-38b843f53711";
const FROST_CLIENT_SECRET = "08a75b8d-ca70-44a9-807d-d79421c082bf";
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
   Frost fetch wrapper with debugging
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
   Helpers
--------------------------------*/
function reduceLatest(frost) {
  const latest = {};
  for (const row of frost?.data ?? []) {
    for (const ob of row.observations ?? []) {
      const { elementId, value, unit } = ob;
      const obsTime = ob.time || row.referenceTime; // ✅ fallback to row referenceTime
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

/* -----------------------------
   🚀 Fetch latest batch data (with fallback)
--------------------------------*/
async function fetchLatestBatch(stationIds) {
  const endISO = new Date().toISOString();
  const start12h = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const start24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const url = new URL(`${FROST_BASE}/observations/v0.jsonld`);
  url.searchParams.set("sources", stationIds.join(","));
  url.searchParams.set("elements", "air_temperature");
  url.searchParams.set("referencetime", `${start12h}/${endISO}`);

  try {
    let frost = await frostJson(url.toString());
    let latestByStation = {};

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

    // 🔄 Fallback: retry last 24h if no 12h data found
    if (Object.keys(latestByStation).length === 0) {
      console.warn(
        `⚠️ No temperature data in last 12h for batch, retrying last 24h...`
      );
      const fallbackURL = new URL(url);
      fallbackURL.searchParams.set("referencetime", `${start24h}/${endISO}`);
      frost = await frostJson(fallbackURL.toString());

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
    }

    return latestByStation;
  } catch (e) {
    console.error("Batch temperature fetch failed:", e.message);
    return {};
  }
}

/* -----------------------------
   Routes
--------------------------------*/

// ✅ Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ✅ Stations — fetch metadata + latest temperature
app.get("/api/stations", async (_req, res) => {
  try {
    const cacheKey = "stations-with-latest-temp";
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    // Fetch all station metadata
    const url = `${FROST_BASE}/sources/v0.jsonld?types=SensorSystem`;
    const frost = await frostJson(url);
    const stations = frost?.data || [];

    // Fetch current temperature in batches of 50
    const BATCH_SIZE = 50;
    const stationChunks = [];
    for (let i = 0; i < stations.length; i += BATCH_SIZE) {
      stationChunks.push(stations.slice(i, i + BATCH_SIZE).map((s) => s.id));
    }

    const allLatest = {};
    for (const chunk of stationChunks) {
      const latest = await fetchLatestBatch(chunk);
      Object.assign(allLatest, latest);
    }

    // Merge temperature into station metadata
    const enrichedStations = stations.map((station) => {
      const temp = allLatest[station.id];
      return {
        ...station,
        latestTemperature: temp
          ? {
              value: temp.value,
              unit: temp.unit,
              time: temp.time,
            }
          : null,
      };
    });

    setCache(cacheKey, enrichedStations, 10 * 60); // Cache 10 minutes
    res.json(enrichedStations);
  } catch (e) {
    console.error("Stations error:", e.message);
    res.status(500).json({ error: "Failed to fetch stations" });
  }
});

// ✅ Observations — single station (with fallback)
app.get("/api/observations/:stationId", async (req, res) => {
  const stationId = req.params.stationId;

  const endISO = new Date().toISOString();
  const start24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const start48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const requestedElements = (req.query.elements ||
    "air_temperature,wind_speed,wind_from_direction,relative_humidity,sum(precipitation_amount PT1H),sum(precipitation_amount P1D),snow_depth"
  ).split(",");

  const url = new URL(`${FROST_BASE}/observations/v0.jsonld`);
  url.searchParams.set("sources", stationId);
  url.searchParams.set("elements", requestedElements.join(","));
  // 🔄 Use last 24h window by default
  url.searchParams.set("referencetime", `${start24h}/${endISO}`);

  try {
    let frost = await frostJson(url.toString());
    let latest = reduceLatest(frost);

    // 🔄 Fallback: retry last 48h if empty
    if (!Object.keys(latest).length) {
      console.warn(
        `⚠️ No data for ${stationId} in last 24h, retrying last 48h...`
      );
      const fallbackURL = new URL(url);
      fallbackURL.searchParams.set("referencetime", `${start48h}/${endISO}`);
      frost = await frostJson(fallbackURL.toString());
      latest = reduceLatest(frost);
    }

    res.json({ stationId, latest });
  } catch (e) {
    console.error(`Observations error for ${stationId}:`, e.message);
    res.json({ stationId, latest: {} });
  }
});



/* -----------------------------
   Debug endpoint
--------------------------------*/
app.get("/api/debug/:stationId", async (req, res) => {
  const { stationId } = req.params;
  const availableURL = `${FROST_BASE}/observations/availableTimeSeries/v0.jsonld?sources=${stationId}`;

  try {
    const available = await frostJson(availableURL);
    res.json({
      stationId,
      availableElements: available?.data ?? [],
    });
  } catch (e) {
    console.error(`Debug endpoint failed for ${stationId}:`, e.message);
    res.status(500).json({ error: "Debug fetch failed" });
  }
});

/* -----------------------------
   Start server
--------------------------------*/
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
