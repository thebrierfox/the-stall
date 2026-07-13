// npi-lookup.js
//
// US National Provider Identifier (NPI) registry lookup.
// Search or look up any US licensed healthcare provider or organization
// by NPI number, name, state, or specialty.
//
// Source: CMS NPI Registry (npiregistry.cms.hhs.gov) — public domain,
// no API key, no auth. 7M+ registered providers. Updated continuously.
//
// Returns: NPI, entity type, name, specialty, credentials, practice
// addresses, license states, and active status.
//
// Use cases: healthcare due diligence, medical billing verification,
// provider credential checks, AML/KYB for healthcare payments, building
// provider directories, fraud detection on health claims.
//
// Seam: NPICheck Pro ($49/mo), Verifyd ($79/mo), Cognizant NPI services
// ($200+/mo). CMS public data delivers the same registry for $0.004/call.
//
// [REDACTED]3, 2026-06-07.

const NPI_BASE = "https://npiregistry.cms.hhs.gov/api/";
const TIMEOUT  = 12_000;
const UA       = "Mozilla/5.0 (compatible; the-stall/1.0; +https://intuitek.ai)";

function buildUrl(query) {
  const url = new URL(NPI_BASE);
  url.searchParams.set("version", "2.1");
  url.searchParams.set("search_type", "NPI");

  if (query.npi)              url.searchParams.set("number",              String(query.npi).trim());
  if (query.first_name)       url.searchParams.set("first_name",          query.first_name.trim());
  if (query.last_name)        url.searchParams.set("last_name",           query.last_name.trim());
  if (query.organization)     url.searchParams.set("organization_name",   query.organization.trim());
  if (query.state)            url.searchParams.set("state",               query.state.trim().toUpperCase());
  if (query.postal_code)      url.searchParams.set("postal_code",         String(query.postal_code).trim());
  if (query.specialty)        url.searchParams.set("taxonomy_description", query.specialty.trim());

  const limit = Math.min(50, Math.max(1, parseInt(query.limit) || 10));
  url.searchParams.set("limit", limit);

  return url.toString();
}

function shapeAddress(addr) {
  if (!addr) return null;
  return {
    purpose:  addr.address_purpose ?? null,
    line1:    addr.address_1 ?? null,
    line2:    addr.address_2 || null,
    city:     addr.city ?? null,
    state:    addr.state ?? null,
    zip:      addr.postal_code ?? null,
    country:  addr.country_code ?? null,
    phone:    addr.telephone_number ?? null,
    fax:      addr.fax_number || null,
  };
}

function shapeProvider(r) {
  const isIndividual = r.enumeration_type === "NPI-1";
  const basic        = r.basic ?? {};

  const name = isIndividual
    ? [basic.first_name, basic.middle_name, basic.last_name]
        .filter(Boolean)
        .join(" ") + (basic.name_suffix ? ` ${basic.name_suffix}` : "")
    : (basic.organization_name ?? null);

  // Primary practice address
  const practiceAddr = (r.addresses ?? [])
    .find(a => a.address_purpose === "LOCATION") ?? (r.addresses ?? [])[0] ?? null;

  // License states from taxonomies
  const licenseStates = (r.taxonomies ?? [])
    .map(t => t.state)
    .filter(Boolean);

  // Primary taxonomy/specialty
  const primaryTax = (r.taxonomies ?? []).find(t => t.primary) ?? (r.taxonomies ?? [])[0] ?? {};

  return {
    npi:              r.number ?? null,
    entity_type:      isIndividual ? "individual" : "organization",
    name:             name,
    credential:       basic.credential || null,
    status:           basic.status === "A" ? "active" : (basic.status ?? null),
    sex:              isIndividual ? (basic.sex === "M" ? "M" : basic.sex === "F" ? "F" : null) : null,
    sole_proprietor:  isIndividual ? (basic.sole_proprietor === "Y") : null,
    specialty:        primaryTax.desc ?? null,
    specialty_code:   primaryTax.code ?? null,
    license_states:   [...new Set(licenseStates)],
    is_primary_taxonomy: primaryTax.primary ?? null,
    practice_address: shapeAddress(practiceAddr),
    enumeration_date: basic.enumeration_date ?? null,
    last_updated:     basic.last_updated ?? null,
  };
}

export default {
  name: "npi-lookup",
  price: "$0.021",

  description:
    "US NPI registry lookup — find any licensed US healthcare provider or organization by NPI number, name, state, or specialty. Returns NPI, entity type, name, credentials, specialty/taxonomy, license states, practice address, and active status. 7M+ records from CMS. Use for provider credentialing, healthcare due diligence, billing verification, or AML/KYB screening on medical payments.",

  inputSchema: {
    type: "object",
    properties: {
      npi: {
        type: "string",
        description: "10-digit NPI number for direct lookup (fastest, most precise).",
      },
      last_name: {
        type: "string",
        description: "Provider last name (individual providers). Supports wildcard with '*' suffix (e.g. 'Smi*').",
      },
      first_name: {
        type: "string",
        description: "Provider first name (individual providers only).",
      },
      organization: {
        type: "string",
        description: "Organization name for NPI-2 (group practices, hospitals, labs, etc.).",
      },
      state: {
        type: "string",
        description: "2-letter US state code to filter by practice location (e.g. 'CA', 'NY').",
      },
      postal_code: {
        type: "string",
        description: "5-digit ZIP code to filter by practice location.",
      },
      specialty: {
        type: "string",
        description: "Taxonomy/specialty description to filter (e.g. 'Internal Medicine', 'Cardiology', 'Psychiatry').",
      },
      limit: {
        type: "integer",
        description: "Max results to return (1–50, default 10).",
        minimum: 1,
        maximum: 50,
        default: 10,
      },
    },
  },

  outputSchema: {
    type: "object",
    properties: {
      result_count: { type: "integer" },
      providers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            npi:              { type: "string" },
            entity_type:      { type: "string" },
            name:             { type: "string" },
            credential:       { type: "string", nullable: true },
            status:           { type: "string" },
            sex:              { type: "string", nullable: true },
            sole_proprietor:  { type: "boolean", nullable: true },
            specialty:        { type: "string", nullable: true },
            specialty_code:   { type: "string", nullable: true },
            license_states:   { type: "array", items: { type: "string" } },
            practice_address: { type: "object", nullable: true },
            enumeration_date: { type: "string", nullable: true },
            last_updated:     { type: "string", nullable: true },
          },
        },
      },
    },
  },

  async handler(query) {
    if (!query.npi && !query.last_name && !query.organization && !query.first_name) {
      throw new Error("Provide at least one of: npi, last_name, organization, first_name");
    }

    const url = buildUrl(query);
    const r   = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal:  AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) throw new Error(`NPI Registry HTTP ${r.status}`);

    const data = await r.json();
    return {
      result_count: data.result_count ?? 0,
      providers:    (data.results ?? []).map(shapeProvider),
    };
  },
};
