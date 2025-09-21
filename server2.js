import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import compression from "compression";

const app = express();
app.use(cors());
app.use(compression());

const PORT = process.env.NVE_PORT || 3002;

/* -----------------------------
   NVE config
--------------------------------*/
const NVE_BASE = "https://hydapi.nve.no/api/v1";
const NVE_API_KEY = process.env.NVE_API_KEY || "ZaDBx37LJUS6vGmXpWYxDQ==";

/**
 * Helper to fetch JSON from NVE
 */
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

/**
 * Split array into chunks of given size
 */
function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

/* -----------------------------
   Routes
--------------------------------*/
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ✅ NVE Stations
app.get("/api/nve/stations", async (_req, res) => {
  try {
    const data = await nveJson(`${NVE_BASE}/Stations`);
    res.json(data?.data ?? []);
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

// ✅ NVE Observations (smarter: checks Series first)
app.get("/api/nve/observations", async (req, res) => {
  try {
    const { stationId } = req.query;
    if (!stationId) {
      return res.status(400).json({ error: "stationId query required" });
    }

    // Step 1: fetch available series for station
    const seriesRes = await nveJson(
      `${NVE_BASE}/Series?StationId=${encodeURIComponent(stationId)}`
    );

    const availableSeries = seriesRes?.data ?? [];

    // Step 2: whitelist of interesting parameters
    const interestingParams = [
      "1000", // Water stage (vannstand)
      "1001", // Discharge
      "200",  // Precipitation
      "515",  // Snow depth
      "1003", // Water temperature
      "17",   // Air temperature
    ];

    const matched = availableSeries.filter((s) =>
      interestingParams.includes(String(s.parameter))
    );

    if (!matched.length) {
      return res.json([]); // nothing useful at this station
    }

    // Step 3: fetch latest observations for each param
    const results = [];
    for (const s of matched) {
      try {
        const url = `${NVE_BASE}/Observations?StationId=${encodeURIComponent(
          stationId
        )}&Parameter=${s.parameter}&ResolutionTime=60`;

        const obsRes = await nveJson(url);

        if (obsRes?.data?.length) {
          results.push(obsRes.data[0]);
        }
      } catch (err) {
        console.warn(
          `[NVE DEBUG] No data for station=${stationId} param=${s.parameter}`
        );
      }
    }

    res.json(results);
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

// ✅ NVE Series
app.get("/api/nve/series", async (req, res) => {
  const { stationId } = req.query;
  if (!stationId) {
    return res.status(400).json({ error: "stationId query required" });
  }

  const url = `${NVE_BASE}/Series?StationId=${stationId}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-API-Key": NVE_API_KEY,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("[NVE DEBUG] /series error:", err);
    res.status(500).json({ error: "Failed to fetch NVE series" });
  }
});

/* -----------------------------
   Start NVE server
--------------------------------*/
app.listen(PORT, () => {
  console.log(`✅ NVE server running on http://localhost:${PORT}`);
});
