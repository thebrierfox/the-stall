// ip-intel.js
//
// IP address and domain geolocation, ASN, and network intelligence.
// Returns country, region, city, coordinates, ISP, org, ASN, reverse DNS,
// and proxy/VPN/mobile flags for any IP or domain name.
//
// Useful for agents auditing infrastructure geography, detecting suspicious
// origins, analyzing blockchain node distributions, or enriching network data.
//
// Free upstream: ip-api.com public API (no auth, 45 req/min rate limit).
// Supports both IPv4/IPv6 addresses and domain names (auto-resolved).

const IPAPI = "http://ip-api.com/json";
const UA    = "Mozilla/5.0 (compatible; the-stall/3.10; +https://intuitek.ai)";
const FIELDS = "status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,reverse,mobile,proxy,hosting,query";

async function lookupSingle(target) {
  const url = `${IPAPI}/${encodeURIComponent(target)}?fields=${FIELDS}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`ip-api HTTP ${resp.status}`);
  const d = await resp.json();
  if (d.status === "fail") throw new Error(`ip-api: ${d.message || "lookup failed"} for '${target}'`);
  return d;
}

function shape(d) {
  return {
    query:        d.query,
    country:      d.country,
    country_code: d.countryCode,
    region:       d.regionName,
    region_code:  d.region,
    city:         d.city,
    zip:          d.zip || null,
    lat:          d.lat,
    lon:          d.lon,
    timezone:     d.timezone,
    isp:          d.isp,
    org:          d.org || null,
    asn:          d.as || null,
    asn_name:     d.asname || null,
    reverse_dns:  d.reverse || null,
    is_mobile:    d.mobile,
    is_proxy:     d.proxy,
    is_hosting:   d.hosting,
  };
}

export default {
  name: "ip-intel",
  price: "$0.059",

  description:
    "Geolocation and network intelligence for IP addresses or domain names. Returns country, region, city, coordinates, ISP, organization, ASN, reverse DNS, and proxy/VPN/mobile/hosting flags. Accepts IPv4, IPv6, or domain names (auto-resolved to IP). Useful for infrastructure audits, fraud detection, blockchain node geography, and origin enrichment.",

  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "IPv4 address, IPv6 address, or domain name to look up (e.g. '8.8.8.8', '2001:4860:4860::8888', 'github.com').",
      },
      targets: {
        type: "array",
        items: { type: "string" },
        description: "Batch lookup: up to 10 IP addresses or domain names. If provided, 'target' is ignored.",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            query:        { type: "string" },
            country:      { type: ["string", "null"] },
            country_code: { type: ["string", "null"] },
            region:       { type: ["string", "null"] },
            city:         { type: ["string", "null"] },
            lat:          { type: ["number", "null"] },
            lon:          { type: ["number", "null"] },
            timezone:     { type: ["string", "null"] },
            isp:          { type: ["string", "null"] },
            org:          { type: ["string", "null"] },
            asn:          { type: ["string", "null"] },
            asn_name:     { type: ["string", "null"] },
            reverse_dns:  { type: ["string", "null"] },
            is_mobile:    { type: "boolean" },
            is_proxy:     { type: "boolean" },
            is_hosting:   { type: "boolean" },
          },
        },
      },
      count:        { type: "integer" },
      generated_at: { type: "string" },
    },
  },

  async handler(query) {
    let targets;
    if (Array.isArray(query.targets) && query.targets.length > 0) {
      targets = query.targets.slice(0, 10).map(t => String(t).trim()).filter(Boolean);
    } else if (query.target) {
      targets = [String(query.target).trim()];
    } else {
      throw new Error("provide 'target' (single) or 'targets' (batch, max 10)");
    }

    if (targets.length === 0) throw new Error("at least one target is required");

    // Sequential to respect ip-api rate limits (45/min free tier)
    const results = [];
    for (const t of targets) {
      const d = await lookupSingle(t);
      results.push(shape(d));
    }

    return {
      results,
      count:        results.length,
      generated_at: new Date().toISOString(),
    };
  },
};
