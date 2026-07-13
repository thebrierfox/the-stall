// geocode.js
//
// Forward and reverse geocoding via OpenStreetMap Nominatim.
// Forward: address/place name → latitude, longitude, bounding box, OSM data.
// Reverse: latitude + longitude → street address and place details.
//
// Useful for agents enriching location data, validating addresses, converting
// user input to coordinates, or building location-aware search flows.
//
// Free upstream: nominatim.openstreetmap.org (no auth, OSM usage policy applies:
// max 1 req/sec, attribution required in any display).

const NOMINATIM = "https://nominatim.openstreetmap.org";
const UA        = "the-stall/3.13 (https://intuitek.ai)";
const TIMEOUT   = 10000;

async function nominatimGet(path) {
  const resp = await fetch(`${NOMINATIM}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) throw new Error(`Nominatim HTTP ${resp.status}`);
  return resp.json();
}

function shapeForward(r) {
  return {
    display_name: r.display_name,
    lat:          parseFloat(r.lat),
    lon:          parseFloat(r.lon),
    type:         r.type || null,
    class:        r.class || null,
    importance:   r.importance ? parseFloat(r.importance.toFixed(4)) : null,
    place_id:     r.place_id,
    osm_type:     r.osm_type || null,
    osm_id:       r.osm_id || null,
    bounding_box: r.boundingbox
      ? {
          south: parseFloat(r.boundingbox[0]),
          north: parseFloat(r.boundingbox[1]),
          west:  parseFloat(r.boundingbox[2]),
          east:  parseFloat(r.boundingbox[3]),
        }
      : null,
    address:      r.address || null,
  };
}

function shapeReverse(r) {
  const addr = r.address || {};
  return {
    display_name:   r.display_name,
    lat:            parseFloat(r.lat),
    lon:            parseFloat(r.lon),
    house_number:   addr.house_number || null,
    road:           addr.road || null,
    neighbourhood:  addr.neighbourhood || addr.suburb || null,
    city:           addr.city || addr.town || addr.village || null,
    county:         addr.county || null,
    state:          addr.state || null,
    postcode:       addr.postcode || null,
    country:        addr.country || null,
    country_code:   addr.country_code?.toUpperCase() || null,
    osm_type:       r.osm_type || null,
    osm_id:         r.osm_id || null,
  };
}

export default {
  name: "geocode",
  price: "$0.021",

  description:
    "Forward and reverse geocoding via OpenStreetMap Nominatim. Forward: convert an address or place name to latitude/longitude, bounding box, and OSM metadata. Reverse: convert lat/lon to a structured street address. Supports any location worldwide. Useful for location enrichment, address validation, coordinate lookup, and building location-aware agent flows.",

  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Address or place name to geocode (forward lookup). Example: '1600 Pennsylvania Ave Washington DC' or 'Eiffel Tower Paris'.",
      },
      lat: {
        type: "number",
        description: "Latitude for reverse geocoding. Requires 'lon' also.",
      },
      lon: {
        type: "number",
        description: "Longitude for reverse geocoding. Requires 'lat' also.",
      },
      limit: {
        type: "integer",
        description: "Max results for forward geocode (default 3, max 10). Ignored for reverse.",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      mode:         { type: "string",  description: "'forward' or 'reverse'." },
      results:      { type: "array",   description: "Geocoding results." },
      count:        { type: "integer" },
      generated_at: { type: "string" },
    },
  },

  async handler(query) {
    const hasQuery   = !!query.query;
    const hasLatLon  = query.lat !== undefined && query.lon !== undefined;

    if (!hasQuery && !hasLatLon) {
      throw new Error("provide 'query' for forward geocoding, or 'lat' + 'lon' for reverse");
    }

    if (hasLatLon) {
      // Reverse geocode
      const lat = parseFloat(query.lat);
      const lon = parseFloat(query.lon);
      if (isNaN(lat) || lat < -90  || lat > 90)  throw new Error("lat must be between -90 and 90");
      if (isNaN(lon) || lon < -180 || lon > 180) throw new Error("lon must be between -180 and 180");

      const data = await nominatimGet(`/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`);
      if (!data || data.error) throw new Error(data?.error || "reverse geocoding failed");
      return {
        mode:         "reverse",
        results:      [shapeReverse(data)],
        count:        1,
        generated_at: new Date().toISOString(),
      };
    }

    // Forward geocode
    const q     = encodeURIComponent(query.query.trim());
    const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 3), 10);
    const data  = await nominatimGet(`/search?q=${q}&format=json&addressdetails=1&limit=${limit}`);

    if (!Array.isArray(data) || data.length === 0) {
      return { mode: "forward", results: [], count: 0, generated_at: new Date().toISOString() };
    }

    return {
      mode:         "forward",
      results:      data.map(shapeForward),
      count:        data.length,
      generated_at: new Date().toISOString(),
    };
  },
};
