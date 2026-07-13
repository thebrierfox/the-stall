// web-company-intel.js
//
// Extract structured company intelligence from any public website.
// Parses OpenGraph tags, schema.org/Organization, meta tags, contact
// info patterns, and social links — returning a clean company profile.
//
// Seam: orbisapi.com/proxy/web-scrape-company-api-cc707 — 1,294 sett/wk,
// 13 payers, $0.005/call. This cap provides equivalent data at $0.003.
//
// Pure text extraction — zero external API calls beyond fetching the URL.

const UA         = "Mozilla/5.0 (compatible; the-stall/3.24; +https://intuitek.ai)";
const TIMEOUT_MS = 12000;
const MAX_BYTES  = 500000;

function extractMeta(html, property, name) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${name || property}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name || property}["']`, "i"),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c)).trim();
  }
  return null;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

function extractJsonLd(html) {
  const results = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      const arr  = Array.isArray(data) ? data : [data];
      for (const d of arr) {
        if (d["@type"] && (
          d["@type"] === "Organization" ||
          d["@type"] === "LocalBusiness" ||
          d["@type"] === "Corporation" ||
          d["@type"] === "WebSite"
        )) results.push(d);
      }
    } catch (_) {}
  }
  return results[0] || null;
}

function extractEmails(html) {
  const found = new Set();
  const re = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const e = m[0].toLowerCase();
    if (!e.includes("example.") && !e.includes("@sentry") &&
        !e.includes("@w3.org") && !e.endsWith(".png") &&
        !e.endsWith(".jpg")) {
      found.add(e);
    }
    if (found.size >= 5) break;
  }
  return [...found];
}

function extractPhones(html) {
  const found = new Set();
  // US/international phone patterns
  const re = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const p = m[0].replace(/\s+/g, " ").trim();
    if (p.length >= 10) { found.add(p); if (found.size >= 3) break; }
  }
  return [...found];
}

function extractSocialLinks(html) {
  const patterns = {
    twitter:   /(?:twitter|x)\.com\/([A-Za-z0-9_]{1,50})(?![\/\w])/,
    linkedin:  /linkedin\.com\/(?:company|in)\/([A-Za-z0-9_\-]{1,100})/,
    github:    /github\.com\/([A-Za-z0-9_\-]{1,100})(?![\/\w])/,
    facebook:  /facebook\.com\/([A-Za-z0-9._\-]{1,100})(?![\/\w])/,
    instagram: /instagram\.com\/([A-Za-z0-9._]{1,100})(?![\/\w])/,
    youtube:   /youtube\.com\/(?:channel|c|@)\/([A-Za-z0-9_\-]{1,100})/,
  };
  const links = {};
  for (const [net, re] of Object.entries(patterns)) {
    const m = html.match(re);
    if (m) links[net] = m[0];
  }
  return links;
}

function extractLogo(html, baseUrl) {
  const patterns = [
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i,
    /<img[^>]+(?:id|class)=["'][^"']*logo[^"']*["'][^>]+src=["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const src = m[1];
      if (src.startsWith("http")) return src;
      try { return new URL(src, baseUrl).href; } catch (_) {}
    }
  }
  return null;
}

function composeProfile(url, title, og, ld, emails, phones, social, logo) {
  const name = ld?.name || og.siteName || og.title
             || (title ? title.split(/[|\-–]/)[0].trim() : null);

  const description = ld?.description || og.description || null;

  const address = ld?.address
    ? typeof ld.address === "string"
      ? ld.address
      : [ld.address.streetAddress, ld.address.addressLocality,
         ld.address.addressRegion, ld.address.addressCountry].filter(Boolean).join(", ")
    : null;

  return {
    name:         name || null,
    description:  description || null,
    url,
    logo:         ld?.logo?.url || ld?.logo || logo || null,
    email:        ld?.email || emails[0] || null,
    emails:       emails.length > 0 ? emails : null,
    phone:        ld?.telephone || phones[0] || null,
    phones:       phones.length > 0 ? phones : null,
    address:      address || null,
    founded:      ld?.foundingDate || null,
    type:         ld?.["@type"] || null,
    social_links: Object.keys(social).length > 0 ? social : null,
    og: {
      title:       og.title || null,
      description: og.description || null,
      image:       og.image || null,
      site_name:   og.siteName || null,
      type:        og.type || null,
    },
    schema_org:   ld ? { type: ld["@type"], raw: ld } : null,
  };
}

export default {
  name: "web-company-intel",
  price: "$0.059",

  description:
    "Extract structured company intelligence from any public website. Returns company name, description, logo, emails, phones, address, founded date, social links (Twitter/LinkedIn/GitHub/etc.), and raw OpenGraph + schema.org/Organization data. Per-URL, entity-parametric — parallel-safe for batch company profiling in agentic pipelines. Pure HTML extraction — no external APIs.",

  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL of the company website to analyze (e.g. 'https://stripe.com').",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      name:         { type: "string" },
      description:  { type: "string" },
      url:          { type: "string" },
      logo:         { type: "string" },
      email:        { type: "string" },
      emails:       { type: "array" },
      phone:        { type: "string" },
      phones:       { type: "array" },
      address:      { type: "string" },
      founded:      { type: "string" },
      type:         { type: "string" },
      social_links: { type: "object" },
      og:           { type: "object" },
      schema_org:   { type: "object" },
      fetch_status: { type: "integer" },
      generated_at: { type: "string" },
    },
  },

  async handler(query) {
    const rawUrl = (query.url || "https://anthropic.com").startsWith("http") ? (query.url || "https://anthropic.com") : `https://${query.url || "anthropic.com"}`;

    let html = "";
    let status = 0;

    const resp = await fetch(rawUrl, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = resp.status;

    if (!resp.ok) {
      return {
        name: null, description: null, url: rawUrl,
        fetch_status: status,
        error: `HTTP ${status}`,
        generated_at: new Date().toISOString(),
      };
    }

    // Read up to MAX_BYTES to avoid memory blow-up
    const reader  = resp.body.getReader();
    const chunks  = [];
    let total     = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= MAX_BYTES) break;
    }
    html = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));

    const og = {
      title:       extractMeta(html, "og:title", "title"),
      description: extractMeta(html, "og:description", "description"),
      image:       extractMeta(html, "og:image", null),
      siteName:    extractMeta(html, "og:site_name", null),
      type:        extractMeta(html, "og:type", null),
    };

    const title  = extractTitle(html);
    const ld     = extractJsonLd(html);
    const emails = extractEmails(html);
    const phones = extractPhones(html);
    const social = extractSocialLinks(html);
    const logo   = extractLogo(html, rawUrl);

    const profile = composeProfile(rawUrl, title, og, ld, emails, phones, social, logo);
    return { ...profile, fetch_status: status, generated_at: new Date().toISOString() };
  },
};
