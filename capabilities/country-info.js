// country-info.js
//
// Country data lookup: name, capital, population, area, languages, currencies,
// region, borders, calling code, and flag emoji. Supports lookup by name,
// ISO 3166-1 alpha-2/alpha-3 code, or capital city.
//
// Useful for international business agents, travel planning, geographic context
// enrichment, currency and language identification, and compliance checks.
//
// Free upstream: restcountries.com v3.1 (no auth, open data).

const BASE     = "https://restcountries.com/v3.1";
const UA       = "Mozilla/5.0 (compatible; the-stall/3.15; +https://intuitek.ai)";
const FIELDS   = "name,cca2,cca3,capital,population,area,region,subregion,languages,currencies,borders,flags,idd,timezones,independent";
const TIMEOUT  = 8000;

async function rcGet(path) {
  const url  = `${BASE}${path}?fields=${FIELDS}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`restcountries HTTP ${resp.status}`);
  const d = await resp.json();
  return Array.isArray(d) ? d : [d];
}

function shape(c) {
  // Currency codes + names
  const currencies = Object.entries(c.currencies || {}).map(([code, info]) => ({
    code,
    name:   info.name   || null,
    symbol: info.symbol || null,
  }));

  // Language list
  const languages = Object.values(c.languages || {});

  // IDD calling code
  const iddRoot    = c.idd?.root || "";
  const iddSuffix  = (c.idd?.suffixes || [])[0] || "";
  const callingCode = iddRoot && iddSuffix ? `${iddRoot}${iddSuffix}` : (iddRoot || null);

  return {
    name:          c.name?.common || null,
    official_name: c.name?.official || null,
    cca2:          c.cca2 || null,
    cca3:          c.cca3 || null,
    capital:       (c.capital || [])[0] || null,
    population:    c.population || null,
    area_km2:      c.area || null,
    region:        c.region || null,
    subregion:     c.subregion || null,
    languages,
    currencies,
    borders:       c.borders || [],
    flag_emoji:    c.flags?.svg ? null : null,  // not reliably present
    flag_png:      c.flags?.png || null,
    calling_code:  callingCode,
    timezones:     c.timezones || [],
    independent:   c.independent ?? null,
  };
}

export default {
  name: "country-info",
  price: "$0.059",

  description:
    "Country information lookup by name, ISO code (alpha-2 or alpha-3), or capital city. Returns: official name, ISO codes, capital, population, area (km²), region, languages, currencies (code + symbol), borders, calling code, timezones, and flag image URL. Useful for international business agents, geographic enrichment, currency identification, and compliance workflows.",

  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Country name or partial name to search (e.g. 'Germany', 'United States', 'Korea').",
      },
      code: {
        type: "string",
        description: "ISO 3166-1 alpha-2 (e.g. 'DE') or alpha-3 (e.g. 'DEU') code for exact lookup.",
      },
      capital: {
        type: "string",
        description: "Capital city name to look up the country by (e.g. 'Berlin', 'Tokyo').",
      },
      region: {
        type: "string",
        enum: ["Africa", "Americas", "Asia", "Europe", "Oceania", "Antarctic"],
        description: "Return all countries in a region.",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      results:      { type: "array" },
      count:        { type: "integer" },
      generated_at: { type: "string" },
    },
  },

  async handler(query) {
    let data;

    if (query.code) {
      const code = query.code.toUpperCase().trim();
      data = await rcGet(`/alpha/${encodeURIComponent(code)}`);
    } else if (query.capital) {
      data = await rcGet(`/capital/${encodeURIComponent(query.capital.trim())}`);
    } else if (query.region) {
      data = await rcGet(`/region/${encodeURIComponent(query.region)}`);
    } else if (query.name) {
      data = await rcGet(`/name/${encodeURIComponent(query.name.trim())}`);
    } else {
      data = await rcGet("/name/United%20States");
    }

    const results = (data || []).map(shape).slice(0, 20);

    return {
      results,
      count:        results.length,
      generated_at: new Date().toISOString(),
    };
  },
};
