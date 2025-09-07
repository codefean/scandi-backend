import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import axios from "axios";
import * as turf from "@turf/turf";

const app = express();
app.use(cors());

// ❄️ Frost API credentials
const FROST_CLIENT_ID = "12f68031-8ce7-48c7-bc7a-38b843f53711";
const FROST_CLIENT_SECRET = "08a75b8d-ca70-44a9-807d-d79421c082bf";

// 🌍 Glacier centroids stored on S3
const GLACIER_CENTROIDS_URL =
  "https://flood-events.s3.us-east-2.amazonaws.com/scandi_glaciers_centroids.geojson";

// 🧊 In-memory cache for glacier data
let glaciers = [];

/**
 * Preload glacier centroids from S3 at startup
 */
const loadGlacierData = async () => {
  try {
    console.log("⬇️ Downloading glacier centroids from S3...");
    const response = await axios.get(GLACIER_CENTROIDS_URL);

    if (response.status === 200 && response.data.features) {
      glaciers = response.data.features;
      console.log(`🧊 Loaded ${glaciers.length} glacier centroids from S3.`);
    } else {
      console.error("❌ Invalid glacier GeoJSON from S3.");
      process.exit(1);
    }
  } catch (error) {
    console.error("🚨 Failed to fetch glacier data from S3:", error.message);
    process.exit(1);
  }
};

// 🔹 Load glacier centroids at startup
await loadGlacierData();

/**
 * API endpoint to fetch weather stations enriched with nearest glacier info
 */
app.get("/api/stations", async (req, res) => {
  try {
    const frostAuth = Buffer.from(
      `${FROST_CLIENT_ID}:${FROST_CLIENT_SECRET}`
    ).toString("base64");

    console.log("🌍 Fetching stations from Frost API...");
    const response = await fetch(
      "https://frost.met.no/sources/v0.jsonld?types=SensorSystem",
      {
        headers: {
          Authorization: `Basic ${frostAuth}`,
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: `Frost API error: ${response.statusText}` });
    }

    const data = await response.json();
    if (!data || !Array.isArray(data.data)) {
      return res.status(500).json({ error: "Invalid Frost API response" });
    }

    console.log(`📡 Received ${data.data.length} stations from Frost API.`);

    // ✅ Enrich stations with nearest glacier info
    const enrichedStations = data.data
      .filter((station) => station.geometry?.coordinates)
      .map((station) => {
        const [lon, lat] = station.geometry.coordinates;
        const stationPoint = turf.point([lon, lat]);

        let closestGlacier = null;
        let minDistance = Infinity;

        for (const glacier of glaciers) {
          const glacierPoint = glacier; // Already a centroid point
          const distance = turf.distance(stationPoint, glacierPoint, {
            units: "kilometers",
          });

          if (distance < minDistance) {
            minDistance = distance;
            closestGlacier = glacier;
          }
        }

        const glacierName =
          closestGlacier?.properties?.glac_name?.trim() || "Ukjent";

        return {
          ...station,
          closestGlacier: glacierName,
          distanceToGlacierKm: isFinite(minDistance)
            ? Math.round(minDistance * 100) / 100
            : null,
        };
      });

    console.log(`✅ Enriched ${enrichedStations.length} stations with glacier data.`);
    res.json(enrichedStations);
  } catch (error) {
    console.error("🚨 Error fetching Frost data:", error);
    res.status(500).json({ error: "Failed to fetch Frost data" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`✅ Backend server running on http://localhost:${PORT}`)
);
