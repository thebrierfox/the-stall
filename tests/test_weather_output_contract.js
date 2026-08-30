import assert from "node:assert/strict";
import test from "node:test";

import weather from "../capabilities/weather.js";

test("weather guarantees the root fields returned by its success handler", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("https://geocoding-api.open-meteo.com/")) {
      return {
        ok: true,
        async json() {
          return {
            results: [{
              name: "London",
              country: "United Kingdom",
              latitude: 51.5,
              longitude: -0.12,
              timezone: "Europe/London",
            }],
          };
        },
      };
    }

    assert.match(href, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
    return {
      ok: true,
      async json() {
        return {
          latitude: 51.5,
          longitude: -0.12,
          timezone: "Europe/London",
          elevation: 11,
          current: {
            time: "2026-08-30T12:00",
            temperature_2m: 18,
            relative_humidity_2m: 70,
            wind_speed_10m: 12,
            precipitation: 0,
            weather_code: 2,
          },
          daily: {
            time: ["2026-08-30"],
            temperature_2m_max: [21],
            temperature_2m_min: [14],
            precipitation_sum: [0],
            wind_speed_10m_max: [16],
            weather_code: [2],
          },
        };
      },
    };
  };

  assert.deepEqual(weather.outputSchema.required, ["location", "current", "forecast", "ts"]);
  const result = await weather.handler({ location: "London", forecast_days: 1 });
  for (const key of weather.outputSchema.required) assert.ok(Object.hasOwn(result, key));
  assert.equal(result.forecast.length, 1);
});
