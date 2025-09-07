import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import fs from "fs";
import path from "path";
import * as turf from "@turf/turf";

const app = express();
app.use(cors());

// ❄️ Frost API credentials
const FROST_CLIENT_ID = "12f68031-8ce7-48c7-bc7a-38b843f53711";
const FROST_CLIENT_SECRET = "08a75b8d-ca70-44a9-807d-d79421c082bf";

// 🧊 Load merged glacier dataset
const glacierDataPath = path.join("data", "scandi_glaciers_merged.geojson");
const glacierData = JSON.parse(fs.readFileSync(glacierDataPath, "utf8"));
const glaciers = glacierData.features;

console.log(`🧊 Loaded ${glaciers.length} glaciers from merged GeoJSON.`);

app.get("/api/stations", async (req, res) => {
  try {
    const frostAuth = Buffer.from(
      `${FROST_CLIENT_ID}:${FROST_CLIENT_SECRET}`
    ).toString("base64");

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

    const enrichedStations = data.data
      .filter((station) => station.geometry?.coordinates)
      .map((station) => {
        const [lon, lat] = station.geometry.coordinates;
        const stationPoint = turf.point([lon, lat]);

        let closestGlacier = null;
        let minDistance = Infinity;

        for (const glacier of glaciers) {
          const glacierCenter = turf.centroid(glacier);
          const distance = turf.distance(stationPoint, glacierCenter, {
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
