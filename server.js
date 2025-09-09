import {
  fetchLatestObservations,
  fetchHistory,
  fetchNormalsMonth,
} from "./frostAPI";

/** ---------- small utils ---------- */
const round = (v, d = 1) =>
  v == null || Number.isNaN(+v) ? null : Number.parseFloat(v).toFixed(d);

const mean = (arr) =>
  arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const sum = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) : null);

const isFiniteNum = (v) => Number.isFinite(v);

/** UTC month boundaries [start, end) */
function monthRangeUTC(year, month1to12) {
  const start = new Date(Date.UTC(year, month1to12 - 1, 1));
  const end = new Date(Date.UTC(year, month1to12, 1));
  return {
    startISO: start.toISOString().slice(0, 10),
    endISO: end.toISOString().slice(0, 10),
  };
}

/** strip units & get numeric array */
function values(series) {
  return (series || [])
    .map((p) => Number(p.value))
    .filter(isFiniteNum);
}

/** pick newest point in a time series */
function newestPoint(series = []) {
  if (!series?.length) return null;
  return series.reduce((a, b) =>
    new Date(a.time) > new Date(b.time) ? a : b
  );
}

/** in-memory browser cache */
const cache = new Map();
function getCache(key, ttlSec) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > ttlSec * 1000) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function setCache(key, data) {
  cache.set(key, { t: Date.now(), data, ttlMs: 0 });
}

/**
 * Robust "latest" getter with fallback to history.
 */
async function getLatestSafe(stationId) {
  try {
    console.log(`[DEBUG] Fetching latest 6h data for ${stationId}`);
    const r1 = await fetchLatestObservations(stationId, { since: "now-6h/now" });
    console.log(`[DEBUG] 6h response for ${stationId}:`, JSON.stringify(r1, null, 2));
    if (r1?.latest && Object.keys(r1.latest).length) return r1.latest;
  } catch (err) {
    console.warn(`⚠️ Failed to fetch 6h data for ${stationId}:`, err);
  }

  try {
    console.log(`[DEBUG] Fetching fallback 24h data for ${stationId}`);
    const r2 = await fetchLatestObservations(stationId, {
      since: "now-24h/now",
      elements:
        "air_temperature,precipitation_amount,wind_speed,wind_from_direction,relative_humidity,snow_depth",
    });
    console.log(`[DEBUG] 24h response for ${stationId}:`, JSON.stringify(r2, null, 2));
    if (r2?.latest && Object.keys(r2.latest).length) return r2.latest;
  } catch (err) {
    console.warn(`⚠️ Failed to fetch 24h data for ${stationId}:`, err);
  }

  try {
    console.log(`[DEBUG] Fetching 7-day historical fallback for ${stationId}`);
    const end = new Date();
    const start = new Date(end);
    start.setUTCDate(end.getUTCDate() - 7);

    const h = await fetchHistory(stationId, {
      startISO: start.toISOString().slice(0, 10),
      endISO: end.toISOString().slice(0, 10),
      elements:
        "air_temperature,precipitation_amount,wind_speed,wind_from_direction,relative_humidity,snow_depth",
      chunkDays: 7,
    });
    console.log(`[DEBUG] Historical response for ${stationId}:`, JSON.stringify(h, null, 2));

    const late = {};
    const lastT = newestPoint(h?.series?.air_temperature);
    const lastP = newestPoint(h?.series?.precipitation_amount);
    const lastW = newestPoint(h?.series?.wind_speed);
    const lastD = newestPoint(h?.series?.wind_from_direction);
    const lastH = newestPoint(h?.series?.relative_humidity);
    const lastS = newestPoint(h?.series?.snow_depth);

    if (lastT) late.air_temperature = { value: lastT.value, unit: lastT.unit, time: lastT.time };
    if (lastP) late.precipitation_amount = { value: lastP.value, unit: lastP.unit, time: lastP.time };
    if (lastW) late.wind_speed = { value: lastW.value, unit: lastW.unit, time: lastW.time };
    if (lastD) late.wind_from_direction = { value: lastD.value, unit: lastD.unit, time: lastD.time };
    if (lastH) late.relative_humidity = { value: lastH.value, unit: lastH.unit, time: lastH.time };
    if (lastS) late.snow_depth = { value: lastS.value, unit: lastS.unit, time: lastS.time };

    return late;
  } catch (err) {
    console.error(`❌ Failed to fetch historical fallback for ${stationId}:`, err);
    return {};
  }
}

/**
 * Get climate normals OR fallback to 5-year averages.
 */
async function getNormalsOrFallback(stationId, month) {
  try {
    console.log(`[DEBUG] Fetching climate normals for ${stationId}, month ${month}`);
    const normals = await fetchNormalsMonth(
      stationId,
      month,
      "mean(air_temperature P1M),sum(precipitation_amount P1M)"
    );
    console.log(`[DEBUG] Normals response for ${stationId}:`, JSON.stringify(normals, null, 2));

    const normalTemp = normals?.rows?.["mean(air_temperature P1M)"]?.[0]?.normal ?? null;
    const normalPrecip = normals?.rows?.["sum(precipitation_amount P1M)"]?.[0]?.normal ?? null;

    if (normalTemp !== null || normalPrecip !== null) {
      return { normalTemp, normalPrecip, basis: `Klimanormaler ${normals?.period || "?"}` };
    }
  } catch (err) {
    console.warn(`⚠️ No Frost normals available for ${stationId}. Falling back to 5-year averages.`, err);
  }

  // 🔄 Fallback: compute 5-year monthly averages
  console.log(`[DEBUG] Computing 5-year fallback averages for ${stationId}, month ${month}`);
  const now = new Date();
  const year = now.getUTCFullYear();
  const years = [1, 2, 3, 4, 5].map((k) => year - k);

  const temps = [];
  const precs = [];

  for (const yr of years) {
    const { startISO, endISO } = monthRangeUTC(yr, month);
    const h = await fetchHistory(stationId, {
      startISO,
      endISO,
      elements: "air_temperature,precipitation_amount",
    });
    console.log(`[DEBUG] Year ${yr} historical data:`, JSON.stringify(h, null, 2));
    temps.push(mean(values(h?.series?.air_temperature)) ?? null);
    precs.push(sum(values(h?.series?.precipitation_amount)) ?? null);
  }

  const avgTemp = temps.filter(isFiniteNum).length ? mean(temps.filter(isFiniteNum)) : null;
  const avgPrecip = precs.filter(isFiniteNum).length ? mean(precs.filter(isFiniteNum)) : null;

  return {
    normalTemp: avgTemp,
    normalPrecip: avgPrecip,
    basis: "Historiske 5-års gjennomsnitt",
  };
}

/**
 * Build the compact summary for a station.
 */
export async function getStationDataSummary(stationId, opts = {}) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const cacheKey = `summary|${stationId}|${year}-${month}`;
  const cached = getCache(cacheKey, 300);
  if (cached && !opts.forceRefresh) return cached;

  const latest = await getLatestSafe(stationId);

  const currentTemp = latest?.air_temperature?.value ?? null;
  const currentPrecip = latest?.precipitation_amount?.value ?? null;

  const normals = await getNormalsOrFallback(stationId, month);
  const normalTempThisMonth = normals.normalTemp;
  const normalPrecipThisMonth = normals.normalPrecip;

  const summary = {
    currentTemp,
    currentPrecip,
    normalTempThisMonth,
    normalPrecipThisMonth,
    normalsBasis: normals.basis,
    display: {
      currentTemp: currentTemp == null ? "—" : `${round(currentTemp, 1)} °C`,
      currentPrecip: currentPrecip == null ? "—" : `${round(currentPrecip, 1)} mm`,
      normalTempThisMonth: normalTempThisMonth == null ? "—" : `${round(normalTempThisMonth, 1)} °C`,
      normalPrecipThisMonth: normalPrecipThisMonth == null ? "—" : `${round(normalPrecipThisMonth, 1)} mm`,
      normalsBasis: normals.basis || "—",
    },
  };

  console.log(`[DEBUG] Final summary for ${stationId}:`, JSON.stringify(summary, null, 2));

  setCache(cacheKey, summary);
  return summary;
}

export default getStationDataSummary;
