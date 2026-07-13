// place-details.js
//
// Enriched business and place details via OpenStreetMap Nominatim.
// Returns website, phone, opening hours, operator, social media links,
// place type, and address — the metadata agents need when research goes
// beyond coordinates. Complementary to geocode (which returns lat/lon only).
//
// Seam: stableenrich.dev/api/google-maps/place-details/partial
//       10,472 settlements/week, 166 payers, $0.0303/call (our price: $0.021)
//
// Upstream: nominatim.openstreetmap.org — free, no auth, 1 req/sec ToS.

const NOMINATIM = "https://nominatim.openstreetmap.org";
const UA        = "the-stall/3.16 (https://intuitek.ai)";
const TIMEOUT   = 10000;

async function searchPlace(query, limit) {
  const q = encodeURIComponent(query.trim());
  const url = `${NOMINATIM}/search?q=${q}&format=json&addressdetails=1&extratags=1&namedetails=1&limit=${limit}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) throw new Error(`Nominatim HTTP ${resp.status}`);
  return resp.json();
}

function extractContact(extratags) {
  if (!extratags) return {};
  return {
    phone:     extratags.phone || extratags["contact:phone"] || null,
    website:   extratags.website || extratags["contact:website"] || null,
    email:     extratags.email || extratags["contact:email"] || null,
    twitter:   extratags["contact:twitter"] || null,
    facebook:  extratags["contact:facebook"] || null,
    instagram: extratags["contact:instagram"] || null,
    youtube:   extratags["contact:youtube"] || null,
    wikipedia: extratags.wikipedia || null,
    wikidata:  extratags.wikidata || null,
  };
}

function shapePlace(r) {
  const tags    = r.extratags || {};
  const addr    = r.address   || {};
  const contact = extractContact(tags);
  return {
    name:          r.name || r.display_name?.split(",")[0] || null,
    display_name:  r.display_name,
    place_type:    r.type || null,
    place_class:   r.class || null,
    lat:           parseFloat(r.lat),
    lon:           parseFloat(r.lon),
    address: {
      house_number: addr.house_number || null,
      road:         addr.road || null,
      neighbourhood:addr.neighbourhood || addr.suburb || null,
      city:         addr.city || addr.town || addr.village || null,
      county:       addr.county || null,
      state:        addr.state || null,
      postcode:     addr.postcode || null,
      country:      addr.country || null,
      country_code: addr.country_code?.toUpperCase() || null,
    },
    contact,
    opening_hours: tags.opening_hours || null,
    operator:      tags.operator || null,
    brand:         tags.brand || null,
    cuisine:       tags.cuisine || null,
    amenity:       tags.amenity || null,
    wheelchair:    tags.wheelchair || null,
    start_date:    tags.start_date || null,
    osm_type:      r.osm_type || null,
    osm_id:        r.osm_id || null,
    importance:    r.importance ? parseFloat(r.importance.toFixed(4)) : null,
  };
}

export default {
  name: "place-details",
  price: "$0.045",

  description:
    "Enriched place and business details by name (OSM Nominatim). Returns website, phone, email, opening hours, operator, brand, cuisine, social media links, full address, and coordinates. Use when you need the business metadata behind a location — not just where it is, but who runs it and how to reach it. Cheaper than Google Maps place details.",

  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Business or place name, optionally with city/region for disambiguation. Examples: 'Starbucks Times Square New York', 'Eiffel Tower Paris', 'Golden Gate Bridge San Francisco'.",
      },
      limit: {
        type: "integer",
        description: "Max results (default 1, max 5). Use >1 when the query may match multiple locations.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      results:      { type: "array",   description: "Matched places with enriched metadata." },
      count:        { type: "integer" },
      generated_at: { type: "string" },
    },
  },

  async handler(query) {
    if (!query.query?.trim()) query.query = "Central Park, New York City";

    const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 1), 5);
    const data  = await searchPlace(query.query, limit);

    if (!Array.isArray(data) || data.length === 0) {
      return { results: [], count: 0, generated_at: new Date().toISOString() };
    }

    return {
      results:      data.map(shapePlace),
      count:        data.length,
      generated_at: new Date().toISOString(),
    };
  },
};
