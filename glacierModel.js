// glacierModel.js
const LAPSE_RATE = -0.0065; // K/m
const T0 = 0.0;
const DDF_SNOW = 3.0; // mm w.e./°C/day
const DDF_ICE = 7.0;
const TS_SNOW = 0.5;
const ROS_P_MIN = 5.0;
const SWE_MIN = 20.0;

function degreeDayMelt(T, snowCover = true) {
  const ddf = snowCover ? DDF_SNOW : DDF_ICE;
  return Math.max(T - T0, 0) * ddf;
}

function snowpackBucket(series, zGlacier, zStation) {
  let swe = 0.0;
  const dz = zGlacier - zStation;

  return series.map((d) => {
    const Tcorr = d.T + LAPSE_RATE * dz;
    const P = d.P || 0;

    if (Tcorr < TS_SNOW) {
      swe += P; // snowfall
    } else {
      const melt = degreeDayMelt(Tcorr, true);
      swe = Math.max(swe - melt, 0);
    }

    const Melt = degreeDayMelt(Tcorr, true);
    const ROS = Tcorr > TS_SNOW && P > ROS_P_MIN && swe > SWE_MIN;

    return { ...d, T: Tcorr, Melt, SWE: swe, ROS };
  });
}

function processGlacier(glacierId, glacName, zGlacier, zStation, series) {
  const history = snowpackBucket(series, zGlacier, zStation);
  const today = history[history.length - 1] || null;

  return {
    glacier_id: glacierId,
    glacier_name: glacName || glacierId,
    today,
    history: history.slice(-14),
    dataQuality: "full",
  };
}

module.exports = { processGlacier, degreeDayMelt };
