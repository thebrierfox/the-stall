// ai-image-gen.js
//
// AI image generation via OpenAI DALL-E 3. Accepts a text prompt, returns
// a hosted image URL (valid for 1 hour) plus generation metadata.
//
// Seam: api.imgzen.dev/v1/models/gpt-image-1/generate — $0.100/image.
// STALL prices at $0.080 (20% below). Upstream cost: $0.040 (DALL-E 3 std).
//
// Upstream: OpenAI Images API via OPENAI_API_KEY.

const OPENAI_IMAGES = "https://api.openai.com/v1/images/generations";
const MODEL         = "dall-e-3";
const TIMEOUT       = 60_000;

export default {
  name:  "ai-image-gen",
  price: "$0.289",

  description:
    "Generate an AI image from a text prompt using DALL-E 3. Returns a public URL for the image (hosted for 1 hour) plus the model's revised prompt. Supports vivid or natural style, and three aspect ratios: square (1024×1024), portrait (1024×1792), or landscape (1792×1024). $0.289/image. Output is base64-encoded PNG or a direct URL depending on response_format.",

  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Text description of the image to generate. Be specific — include subject, style, lighting, mood, and composition for best results. Max 4000 characters.",
        maxLength: 4000,
      },
      style: {
        type: "string",
        enum: ["vivid", "natural"],
        description: "Image style. 'vivid' produces hyper-real, dramatic compositions. 'natural' produces softer, more realistic images. Default: vivid.",
      },
      size: {
        type: "string",
        enum: ["1024x1024", "1024x1792", "1792x1024"],
        description: "Image dimensions. '1024x1024' is square (default), '1024x1792' is portrait, '1792x1024' is landscape.",
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      url:            { type: "string",          description: "Public URL of the generated image. Valid for 1 hour — download promptly." },
      revised_prompt: { type: ["string", "null"], description: "The prompt as reinterpreted by DALL-E 3, which may include additional detail." },
      model:          { type: "string" },
      style:          { type: "string" },
      size:           { type: "string" },
      duration_ms:    { type: "integer" },
      ts:             { type: "string" },
    },
  },

  async handler({ prompt = "A serene mountain landscape at golden hour", style, size }) {
    const p = (prompt || "A serene mountain landscape at golden hour").trim().slice(0, 4000);

    const s    = ["vivid", "natural"].includes(style) ? style : "vivid";
    const dims = ["1024x1024", "1024x1792", "1792x1024"].includes(size) ? size : "1024x1024";

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

    const t0   = Date.now();
    const resp = await fetch(OPENAI_IMAGES, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:   MODEL,
        prompt:  p,
        n:       1,
        size:    dims,
        style:   s,
        quality: "standard",
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => String(resp.status));
      throw new Error(`OpenAI Images API ${resp.status}: ${err.slice(0, 200)}`);
    }

    const data    = await resp.json();
    const img     = data.data?.[0];
    if (!img || !img.url) throw new Error("OpenAI returned no image URL");

    return {
      url:            img.url,
      revised_prompt: img.revised_prompt || null,
      model:          MODEL,
      style:          s,
      size:           dims,
      duration_ms:    Date.now() - t0,
      ts:             new Date().toISOString(),
    };
  },
};
