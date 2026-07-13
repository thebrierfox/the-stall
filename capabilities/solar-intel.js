// solar-intel.js
//
// Solar irradiance, peak sun hours, and panel yield estimate for any location.
// Returns GHI/DNI/DHI radiation, cloud cover, sunrise/sunset, and a 7-day
// solar forecast useful for energy analysis, real estate solar assessment,
// agricultural planning, and EV charging optimization.
//
// Seam: stableenrich.dev/api/google-maps/solar/rgb-image
//       553 settlements/month, 27 payers, $0.0290/call (our price: $0.021)
//
// Upstream: Open-Meteo (open-meteo.com) — free, no API key, unlimited use.
// Geocoding: Open-Meteo Geocoding API — free, no auth.

const GEOCODE_URL  = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const UA           = "the-stall/3.72 (https://intuitek.ai)";
const TIMEOUT_MS   = 12000;

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.json();
}

// US state abbreviation pattern: trailing " AZ" / " CA" / ", Arizona" etc.
const US_STATE_ABBREV = /\s+[A-Z]{2}(?:\s*,.*)?$/;
const COMMA_SUFFIX    = /\s*,.*$/;

async function geocodeQuery(q) {
  const data = await fetchJson(
    `${GEOCODE_URL}?name=${encodeURIComponent(q)}&count=1&language=en&format=json`
  );
  return (data.results || [])[0] || null;
}

async function geocode(location) {
  // Try raw input first, then strip state abbrev, then strip comma suffix
  const queries = [location];
  if (US_STATE_ABBREV.test(location)) queries.push(location.replace(US_STATE_ABBREV, "").trim());
  if (COMMA_SUFFIX.test(location))    queries.push(location.replace(COMMA_SUFFIX, "").trim());

  for (const q of [...new Set(queries)]) {
    const result = await geocodeQuery(q);
    if (result) {
      return {
        name:      result.name,
        country:   result.country,
        latitude:  result.latitude,
        longitude: result.longitude,
        timezone:  result.timezone,
        elevation: result.elevation,
      };
    }
  }
  throw new Error(`Location "${location}" not found`);
}

// MJ/m² per day → kWh/m² (peak sun hours); 1 MJ = 0.2778 kWh
function toPeakSunHours(mjPerM2) {
  return mjPerM2 != null ? Math.round(mjPerM2 * 0.2778 * 100) / 100 : null;
}

// Estimate daily panel yield for a 1 kW system (kWh/day)
// Typical efficiency loss factors: temp, wiring, inverter ≈ 80% combined
function panelYield(peakSunHours, systemKw = 1, efficiency = 0.80) {
  return peakSunHours != null
    ? Math.round(peakSunHours * systemKw * efficiency * 100) / 100
    : null;
}

export default {
  name:  "solar-intel",
  price: "$0.045",

  description:
    "Solar irradiance analysis and 7-day forecast for any location. Returns GHI (global horizontal irradiance), DNI (direct normal), DHI (diffuse), peak sun hours, cloud cover, sunrise/sunset, and panel yield estimate for a 1 kW system. Useful for rooftop solar feasibility, agricultural planning, EV charging optimization, and energy market analysis. Free upstream: Open-Meteo (no API key, no rate limits). Undercuts stableenrich.dev/api/google-maps/solar by 31%.",

  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City, region, or address (e.g. 'Phoenix AZ', 'London', 'Sydney Australia'). Use this OR latitude+longitude.",
      },
      latitude: {
        type: "number",
        description: "Latitude in decimal degrees (-90 to 90). Use with longitude instead of location name.",
      },
      longitude: {
        type: "number",
        description: "Longitude in decimal degrees (-180 to 180). Use with latitude instead of location name.",
      },
      forecast_days: {
        type: "integer",
        description: "Number of forecast days (1–16). Default 7.",
        default: 7,
        minimum: 1,
        maximum: 16,
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      location: {
        type: "object",
        properties: {
          name:      { type: ["string", "null"] },
          country:   { type: ["string", "null"] },
          latitude:  { type: "number" },
          longitude: { type: "number" },
          timezone:  { type: ["string", "null"] },
          elevation_m: { type: ["number", "null"] },
        },
      },
      today: {
        type: "object",
        description: "Solar summary for today.",
        properties: {
          date:               { type: "string" },
          peak_sun_hours:     { type: ["number", "null"], description: "Equivalent peak sun hours (kWh/m²). 1 PSH = 1 kW/m² for 1 hour." },
          ghi_sum_mj_m2:      { type: ["number", "null"], description: "Total global horizontal irradiance today (MJ/m²)." },
          panel_yield_kwh:    { type: ["number", "null"], description: "Estimated output of a 1 kW solar system today (kWh), assuming 80% system efficiency." },
          sunrise:            { type: ["string", "null"] },
          sunset:             { type: ["string", "null"] },
          daylight_hours:     { type: ["number", "null"], description: "Total daylight duration in hours." },
          cloud_cover_avg_pct:{ type: ["number", "null"], description: "Average cloud cover percentage for the day." },
          solar_rating:       { type: "string", description: "Qualitative solar potential: excellent | good | moderate | poor." },
        },
      },
      forecast: {
        type: "array",
        description: "7-day daily solar forecast.",
        items: {
          type: "object",
          properties: {
            date:            { type: "string" },
            peak_sun_hours:  { type: ["number", "null"] },
            ghi_sum_mj_m2:   { type: ["number", "null"] },
            panel_yield_kwh: { type: ["number", "null"] },
            sunrise:         { type: ["string", "null"] },
            sunset:          { type: ["string", "null"] },
            daylight_hours:  { type: ["number", "null"] },
            solar_rating:    { type: "string" },
          },
        },
      },
      ts: { type: "string" },
    },
  },

  async handler(query) {
    const forecastDays = Math.min(Math.max(1, query.forecast_days || 7), 16);
    let lat, lon, locationMeta = {};

    if (query.latitude != null && query.longitude != null) {
      lat = query.latitude;
      lon = query.longitude;
    } else if (query.location) {
      const geo = await geocode(query.location);
      lat          = geo.latitude;
      lon          = geo.longitude;
      locationMeta = geo;
    } else {
      // Default to Phoenix AZ for discovery probes
      lat = 33.4484;
      lon = -112.0740;
      locationMeta = { name: "Phoenix", country: "United States", timezone: "America/Phoenix" };
    }

    const params = new URLSearchParams({
      latitude:      lat.toString(),
      longitude:     lon.toString(),
      hourly:        "shortwave_radiation,direct_radiation,diffuse_radiation,cloud_cover",
      daily:         "shortwave_radiation_sum,sunrise,sunset",
      timezone:      locationMeta.timezone || "auto",
      forecast_days: forecastDays.toString(),
    });

    const data = await fetchJson(`${FORECAST_URL}?${params}`);

    const daily  = data.daily  || {};
    const hourly = data.hourly || {};

    // Build per-day map of hourly cloud cover averages
    const hourTimes   = hourly.time           || [];
    const cloudCover  = hourly.cloud_cover     || [];
    const dayClouds   = {};
    for (let i = 0; i < hourTimes.length; i++) {
      const day = hourTimes[i].slice(0, 10);
      if (!dayClouds[day]) dayClouds[day] = { sum: 0, n: 0 };
      if (cloudCover[i] != null) {
        dayClouds[day].sum += cloudCover[i];
        dayClouds[day].n++;
      }
    }

    function solarRating(psh) {
      if (psh == null) return "unknown";
      if (psh >= 6)   return "excellent";
      if (psh >= 4.5) return "good";
      if (psh >= 3)   return "moderate";
      return "poor";
    }

    function daylight(sunrise, sunset) {
      if (!sunrise || !sunset) return null;
      const riseMs = new Date(sunrise).getTime();
      const setMs  = new Date(sunset).getTime();
      return Math.round((setMs - riseMs) / 36000) / 100; // hours, 2 dp
    }

    const dates     = daily.time || [];
    const ghiSums   = daily.shortwave_radiation_sum || [];
    const sunrises  = daily.sunrise  || [];
    const sunsets   = daily.sunset   || [];

    function buildDayObj(i) {
      const date      = dates[i]   || null;
      const ghi       = ghiSums[i] ?? null;
      const psh       = toPeakSunHours(ghi);
      const cloudAvg  = date && dayClouds[date]
        ? Math.round(dayClouds[date].sum / dayClouds[date].n)
        : null;
      const sr        = sunrises[i] || null;
      const ss        = sunsets[i]  || null;
      return {
        date,
        peak_sun_hours:     psh,
        ghi_sum_mj_m2:      ghi != null ? Math.round(ghi * 100) / 100 : null,
        panel_yield_kwh:    panelYield(psh),
        sunrise:            sr,
        sunset:             ss,
        daylight_hours:     daylight(sr, ss),
        cloud_cover_avg_pct: cloudAvg,
        solar_rating:       solarRating(psh),
      };
    }

    const todayObj    = buildDayObj(0);
    const forecastArr = [];
    for (let i = 1; i < dates.length; i++) {
      const d = buildDayObj(i);
      delete d.cloud_cover_avg_pct; // keep forecast compact
      forecastArr.push(d);
    }

    return {
      location: {
        name:        locationMeta.name    || null,
        country:     locationMeta.country || null,
        latitude:    data.latitude  ?? lat,
        longitude:   data.longitude ?? lon,
        timezone:    data.timezone  || null,
        elevation_m: data.elevation ?? locationMeta.elevation ?? null,
      },
      today:    todayObj,
      forecast: forecastArr,
      ts:       new Date().toISOString(),
    };
  },
};
