// open-food-intel.js
//
// Open Food Facts nutritional database — 3M+ consumer food products
// from 160+ countries, contributed by global volunteers and NGOs.
//
// Two modes:
//   1. search(query, limit, nutrition_grade, country)
//      — keyword search for products by name/brand/category. Returns
//        Nutri-Score, NOVA processing group, macros, allergens, and
//        ecoscore. Optionally filter by Nutri-Score grade (A–E) or country.
//
//   2. barcode(code)
//      — exact lookup by UPC (12-digit), EAN-13, or EAN-8 barcode.
//        Returns full nutritional profile: all macros and micronutrients
//        per 100g and per serving, ingredients, additives, allergens.
//
// Source: world.openfoodfacts.org (CC BY-SA 4.0, open data, no API key).
// Updated continuously by community — 3M+ products, 160+ countries.
//
// Nutri-Score grades: A (best) → E (worst). Nova groups: 1=unprocessed,
// 2=processed culinary ingredients, 3=processed foods, 4=ultra-processed.
// Eco-Score: environmental impact (A=lowest → E=highest impact).
//
// Seam: health/diet agents tracking macros for meal plans, grocery agents
// checking allergens for dietary restrictions, food compliance agents
// verifying nutrition labels, recipe agents comparing product options.
// First food/nutrition cap in the STALL catalog — 255-cap gap now closed.
//
// Price: $0.008/call — single Open Food Facts API call.

const OFF_BASE = "https://world.openfoodfacts.org";
const UA       = "the-stall/4.68.3 open-food-intel (kyle@intuitek.ai)";
const TIMEOUT  = 14_000;

// Fields to request from the API (minimizes payload size)
const SEARCH_FIELDS = [
  "code",
  "product_name",
  "brands",
  "categories",
  "nutrition_grades",
  "nova_group",
  "ecoscore_grade",
  "nutriments",
  "allergens_tags",
  "additives_n",
  "serving_size",
  "countries_tags",
  "image_front_small_url",
].join(",");

const BARCODE_FIELDS = SEARCH_FIELDS + ",ingredients_text_en,ingredients_text,product_quantity,packaging_tags";

// Nutri-Score grade descriptions
const NUTRI_DESC = {
  a: "Excellent nutritional quality",
  b: "Good nutritional quality",
  c: "Average nutritional quality",
  d: "Poor nutritional quality",
  e: "Bad nutritional quality",
};

// NOVA group descriptions
const NOVA_DESC = {
  1: "Unprocessed or minimally processed",
  2: "Processed culinary ingredients",
  3: "Processed foods",
  4: "Ultra-processed food and drink products",
};

async function offFetch(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Open Food Facts HTTP ${res.status} — ${url}`);
  return res.json();
}

// Clean allergen tags: "en:gluten" → "gluten"
function cleanAllergens(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return [];
  return tags
    .map((t) => t.replace(/^[a-z]{2}:/, ""))
    .filter((t) => !t.startsWith("en:"))
    .slice(0, 12);
}

// Extract key nutrients per 100g
function extractNutrients(n) {
  if (!n || typeof n !== "object") return {};
  const pick = (key) => {
    const v = n[key];
    return v != null ? parseFloat(Number(v).toFixed(2)) : null;
  };
  return {
    calories_kcal:   pick("energy-kcal_100g") ?? pick("energy_100g"),
    fat_g:           pick("fat_100g"),
    saturated_fat_g: pick("saturated-fat_100g"),
    carbs_g:         pick("carbohydrates_100g"),
    sugars_g:        pick("sugars_100g"),
    fiber_g:         pick("fiber_100g"),
    protein_g:       pick("proteins_100g"),
    salt_g:          pick("salt_100g"),
    sodium_mg:       n["sodium_100g"] != null
                       ? parseFloat((n["sodium_100g"] * 1000).toFixed(1))
                       : null,
  };
}

// Extract per-serving nutrients
function extractServingNutrients(n) {
  if (!n || typeof n !== "object") return null;
  const pick = (key) => {
    const v = n[key];
    return v != null ? parseFloat(Number(v).toFixed(2)) : null;
  };
  const calories = pick("energy-kcal_serving") ?? pick("energy_serving");
  if (calories == null) return null;
  return {
    calories_kcal:   calories,
    fat_g:           pick("fat_serving"),
    saturated_fat_g: pick("saturated-fat_serving"),
    carbs_g:         pick("carbohydrates_serving"),
    sugars_g:        pick("sugars_serving"),
    fiber_g:         pick("fiber_serving"),
    protein_g:       pick("proteins_serving"),
    salt_g:          pick("salt_serving"),
  };
}

function formatProduct(p) {
  const grade = (p.nutrition_grades ?? "").toLowerCase().replace(/[^a-e]/g, "") || null;
  const nova  = p.nova_group != null ? parseInt(p.nova_group, 10) : null;
  const eco   = (p.ecoscore_grade ?? "").toLowerCase().replace(/[^a-e]/g, "") || null;

  const serving = extractServingNutrients(p.nutriments);

  return {
    barcode:        p.code ?? null,
    name:           p.product_name?.trim() || null,
    brands:         p.brands?.trim() || null,
    categories:     p.categories
                      ? p.categories.split(",").map((c) => c.trim()).filter(Boolean).slice(0, 5)
                      : [],
    nutri_score:    grade ? { grade: grade.toUpperCase(), description: NUTRI_DESC[grade] ?? null } : null,
    nova_group:     nova  ? { group: nova, description: NOVA_DESC[nova] ?? null } : null,
    eco_score:      eco   ? eco.toUpperCase() : null,
    serving_size:   p.serving_size?.trim() || null,
    per_100g:       extractNutrients(p.nutriments),
    per_serving:    serving,
    allergens:      cleanAllergens(p.allergens_tags),
    additives_count: p.additives_n ?? null,
    countries:      Array.isArray(p.countries_tags)
                      ? p.countries_tags.map((c) => c.replace(/^en:/, "")).slice(0, 5)
                      : [],
    image_url:      p.image_front_small_url ?? null,
  };
}

// --- Mode: search ---

async function searchProducts(query, limit = 10, nutritionGrade, country) {
  const cap = Math.min(Math.max(1, limit), 20);

  const url = new URL(`${OFF_BASE}/api/v2/search`);
  url.searchParams.set("search_terms", query.trim());
  url.searchParams.set("page_size", cap);
  url.searchParams.set("page", 1);
  url.searchParams.set("fields", SEARCH_FIELDS);
  url.searchParams.set("sort_by", "unique_scans_n"); // most popular first

  if (nutritionGrade && nutritionGrade !== "all") {
    url.searchParams.set("nutrition_grades_tags", nutritionGrade.toLowerCase());
  }
  if (country) {
    url.searchParams.set("countries_tags", `en:${country.toLowerCase().replace(/\s+/g, "-")}`);
  }

  const data = await offFetch(url.toString());
  const raw  = data.products ?? [];

  if (raw.length === 0) {
    return {
      mode:    "search",
      query,
      total:   data.count ?? 0,
      results: [],
      source:  "Open Food Facts — world.openfoodfacts.org (CC BY-SA 4.0)",
    };
  }

  return {
    mode:    "search",
    query,
    total:   data.count ?? raw.length,
    returned: raw.length,
    products: raw.map(formatProduct),
    source:  "Open Food Facts — world.openfoodfacts.org (CC BY-SA 4.0)",
    note:    `Sorted by popularity (unique scans). Nutri-Score A–E (A=best). NOVA 1–4 (4=ultra-processed).`,
  };
}

// --- Mode: barcode ---

async function barcodeProduct(code) {
  const clean = String(code).replace(/\D/g, "");
  if (clean.length < 8) throw new Error("code must be a valid UPC (12-digit) or EAN-13/8 barcode");

  const url = `${OFF_BASE}/api/v3/product/${encodeURIComponent(clean)}.json?fields=${encodeURIComponent(BARCODE_FIELDS)}`;
  const data = await offFetch(url);

  if (data.status === "failure" || !data.product) {
    return {
      mode:    "barcode",
      barcode: clean,
      found:   false,
      message: `No product found for barcode ${clean}.`,
      source:  "Open Food Facts — world.openfoodfacts.org (CC BY-SA 4.0)",
    };
  }

  const p       = data.product;
  const base    = formatProduct({ ...p, code: clean });

  // Barcode mode: add ingredients and packaging
  const ingredients = (p.ingredients_text_en ?? p.ingredients_text ?? "").slice(0, 600).trim() || null;
  const qty = p.product_quantity?.trim() || null;
  const packaging = Array.isArray(p.packaging_tags)
    ? p.packaging_tags.map((t) => t.replace(/^en:/, "")).filter(Boolean).slice(0, 6)
    : [];

  return {
    mode:         "barcode",
    found:        true,
    ...base,
    product_quantity: qty,
    ingredients,
    packaging,
    source:       "Open Food Facts — world.openfoodfacts.org (CC BY-SA 4.0)",
    off_url:      `https://world.openfoodfacts.org/product/${clean}/`,
  };
}

// --- Handler ---

export default {
  name:  "open-food-intel",
  price: "$0.021",

  description:
    "Open Food Facts nutritional intelligence — 3M+ consumer food products. Two modes: (1) search: keyword search returning Nutri-Score (A–E), NOVA processing level (1–4), macronutrients per 100g, allergens, eco-score, and popularity rank. (2) barcode: exact UPC/EAN lookup with full nutritional profile per 100g and per serving, complete ingredients list, and packaging info. Useful for meal-planning agents, dietary restriction checkers, grocery comparison tools, and food compliance research. No API key required.",

  inputSchema: {
    type:       "object",
    properties: {
      mode: {
        type:        "string",
        enum:        ["search", "barcode"],
        description: "search — keyword query across 3M+ products. barcode — exact UPC/EAN lookup.",
      },
      query: {
        type:        "string",
        description: "Product name, brand, or keyword (required for search mode).",
      },
      code: {
        type:        "string",
        description: "UPC (12-digit), EAN-13, or EAN-8 barcode (required for barcode mode).",
      },
      limit: {
        type:        "integer",
        minimum:     1,
        maximum:     20,
        description: "Number of results for search mode (1–20). Default: 10.",
      },
      nutrition_grade: {
        type:        "string",
        enum:        ["a", "b", "c", "d", "e", "all"],
        description: "Filter search results by Nutri-Score grade. a=best, e=worst, all=no filter. Default: all.",
      },
      country: {
        type:        "string",
        description: "Filter search by country (e.g. 'united-states', 'france', 'japan'). Default: all countries.",
      },
    },
    required:            ["mode"],
    additionalProperties: false,
  },

  outputSchema: {
    type:       "object",
    properties: {
      mode:     { type: "string" },
      query:    { type: "string" },
      products: { type: "array" },
      found:    { type: "boolean" },
      source:   { type: "string" },
    },
  },

  async handler(params) {
    const { mode, query, code, limit, nutrition_grade, country } = params;

    if (mode === "barcode") {
      if (!code) throw new Error("barcode mode requires 'code' (UPC or EAN barcode)");
      return barcodeProduct(code);
    }

    if (mode === "search") {
      if (!query) throw new Error("search mode requires 'query'");
      return searchProducts(query, limit, nutrition_grade, country);
    }

    throw new Error(`Unknown mode '${mode}'. Use 'search' or 'barcode'.`);
  },
};
