// weather.js
//
// Current weather and 7-day forecast for any location.
// Sourced from Open-Meteo (free, no API key, unlimited requests).
//
// DeFi relevance: weather affects energy prices (Bitcoin mining profitability),
// agricultural commodity prices (DeFi prediction markets), natural disaster
// risk (on-chain insurance protocols), and regional economic activity.

const GEOCODE_URL  = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const UA           = "Mozilla/5.0 (compatible; the-stall/2.4; +https://intuitek.ai)";
const TIMEOUT_MS   = 10000;

// WMO weather codes → human-readable description
const WMO = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Foggy", 48: "Icy fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
};

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.json();
}

async function geocode(location) {
  const data = await fetchJson(
    `${GEOCODE_URL}?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
  );
  const result = (data.results || [])[0];
  if (!result) throw new Error(`Location "${location}" not found`);
  return {
    name:      result.name,
    country:   result.country,
    latitude:  result.latitude,
    longitude: result.longitude,
    timezone:  result.timezone,
  };
}

export default {
  name:  "weather",
  price: "$0.039",

  description:
    "Current weather conditions and 7-day daily forecast for any location worldwide. Input a city name, coordinates, or address. Returns temperature (°C), humidity, wind speed, precipitation, weather code, and a forecast with high/low temps and precipitation totals. Free upstream: Open-Meteo (no API key, no rate limits). Useful for DeFi agents tracking energy markets (cold → heating demand → gas prices), agricultural commodity prediction markets, or natural disaster risk assessment for on-chain insurance.",

  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name, region, or address (e.g. 'New York', 'London UK', 'Tokyo'). Use this OR latitude/longitude.",
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
          elevation: { type: ["number", "null"], description: "Elevation in meters." },
        },
      },
      current: {
        type: "object",
        properties: {
          time:            { type: "string" },
          temperature_c:   { type: "number" },
          temperature_f:   { type: "number" },
          humidity_pct:    { type: "number" },
          wind_speed_kmh:  { type: "number" },
          precipitation_mm:{ type: "number" },
          weather_code:    { type: "integer" },
          condition:       { type: "string", description: "Human-readable condition from WMO code." },
        },
      },
      forecast: {
        type: "array",
        description: "Daily forecast.",
        items: {
          type: "object",
          properties: {
            date:               { type: "string" },
            max_temp_c:         { type: "number" },
            min_temp_c:         { type: "number" },
            precipitation_mm:   { type: "number" },
            max_wind_kmh:       { type: "number" },
            weather_code:       { type: "integer" },
            condition:          { type: "string" },
          },
        },
      },
      ts: { type: "string" },
    },
    required: ["location", "current", "forecast", "ts"],
  },

  async handler(query) {
    let lat, lon, locationMeta = {};
    const forecastDays = Math.min(Math.max(1, query.forecast_days || 7), 16);

    if (query.latitude != null && query.longitude != null) {
      lat = query.latitude;
      lon = query.longitude;
    } else if (query.location) {
      const geo = await geocode(query.location);
      lat          = geo.latitude;
      lon          = geo.longitude;
      locationMeta = geo;
    } else {
      throw new Error("Provide either 'location' (city name) or 'latitude'+'longitude'");
    }

    const params = new URLSearchParams({
      latitude:  lat.toString(),
      longitude: lon.toString(),
      current:   "temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,weather_code",
      daily:     "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code",
      timezone:  locationMeta.timezone || "auto",
      forecast_days: forecastDays.toString(),
    });

    const data = await fetchJson(`${FORECAST_URL}?${params}`);

    const cur = data.current || {};
    const daily = data.daily || {};

    const tempC = cur.temperature_2m ?? null;
    const tempF = tempC !== null ? Math.round((tempC * 9 / 5 + 32) * 10) / 10 : null;

    const forecastArr = [];
    const dates   = daily.time                 || [];
    const maxTemps = daily.temperature_2m_max  || [];
    const minTemps = daily.temperature_2m_min  || [];
    const precip   = daily.precipitation_sum   || [];
    const wind     = daily.wind_speed_10m_max  || [];
    const codes    = daily.weather_code        || [];

    for (let i = 0; i < dates.length; i++) {
      forecastArr.push({
        date:             dates[i],
        max_temp_c:       maxTemps[i] ?? null,
        min_temp_c:       minTemps[i] ?? null,
        precipitation_mm: precip[i]   ?? 0,
        max_wind_kmh:     wind[i]     ?? null,
        weather_code:     codes[i]    ?? null,
        condition:        WMO[codes[i]] || `WMO ${codes[i]}`,
      });
    }

    return {
      location: {
        name:      locationMeta.name    || null,
        country:   locationMeta.country || null,
        latitude:  data.latitude,
        longitude: data.longitude,
        timezone:  data.timezone || null,
        elevation: data.elevation || null,
      },
      current: {
        time:             cur.time,
        temperature_c:    tempC,
        temperature_f:    tempF,
        humidity_pct:     cur.relative_humidity_2m ?? null,
        wind_speed_kmh:   cur.wind_speed_10m ?? null,
        precipitation_mm: cur.precipitation  ?? 0,
        weather_code:     cur.weather_code   ?? null,
        condition:        WMO[cur.weather_code] || `WMO ${cur.weather_code}`,
      },
      forecast: forecastArr,
      ts: new Date().toISOString(),
    };
  },
};
