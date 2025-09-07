import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

// ❗ Frost API credentials (hardcoded for now)
const FROST_CLIENT_ID = "12f68031-8ce7-48c7-bc7a-38b843f53711";
const FROST_CLIENT_SECRET = "08a75b8d-ca70-44a9-807d-d79421c082bf";

// ✅ Endpoint to fetch stations
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

    res.json(data.data);
  } catch (error) {
    console.error("🚨 Error fetching Frost data:", error);
    res.status(500).json({ error: "Failed to fetch Frost data" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`✅ Backend server running on http://localhost:${PORT}`)
);
