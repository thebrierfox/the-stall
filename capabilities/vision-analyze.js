// vision-analyze.js
//
// AI vision analysis of any image URL using GPT-4o-mini vision.
// Fetches the image URL and sends it to OpenAI's vision model for
// structured analysis, description, or Q&A about image content.
//
// Use cases: screenshot analysis, chart/graph reading, document OCR,
// product identification, scene description, UI analysis.
//
// Seam: no x402 vision equivalent in CDP Bazaar as of 2026-06-10.
// Fills the gap between image-detect (format only) and ai-image-gen (generate).
//
// Upstream: GPT-4o-mini vision via OPENAI_API_KEY ($0.002 avg per call).
// Version: the-stall/4.61.0

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL      = "gpt-4o-mini";
const TIMEOUT    = 45_000;

// Default analysis types and their system prompts
const ANALYSIS_MODES = {
  describe: "You are a precise visual analyst. Describe the image content in detail: what you see, key elements, colors, text visible, layout, and context. Be factual and structured.",
  ocr:      "You are an OCR assistant. Extract ALL text visible in the image, preserving formatting where meaningful. Return text verbatim, organized by visual region (top-left to bottom-right).",
  chart:    "You are a data analyst. Analyze this chart or graph: identify the chart type, axes, units, key data points, trends, and the main insight the chart communicates. Extract specific numbers where visible.",
  ui:       "You are a UI/UX analyst. Analyze this interface screenshot: identify the component type, key interactive elements, navigation structure, content layout, and any notable UX patterns or issues.",
  identify: "You are an object identification assistant. Identify the main subject(s) in the image: type, brand if visible, key characteristics, and condition or state. Be specific and factual.",
  qa:       null, // uses the user's question as the prompt
};

export default {
  name:  "vision-analyze",
  price: "$0.050",
  tags: ["vision", "image-analysis", "evidence", "multimodal"],

  description:
    "Analyze any image URL using GPT-4o-mini vision. Returns structured analysis based on the mode: describe (full description), ocr (text extraction), chart (data/trend extraction), ui (interface analysis), identify (object/subject ID), or qa (answer a specific question about the image). Input must be a publicly accessible image URL (JPEG, PNG, GIF, WebP). $0.050/call.",

  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Publicly accessible URL of the image to analyze. Must return image/jpeg, image/png, image/gif, or image/webp content-type. Max file size: 20MB.",
      },
      mode: {
        type: "string",
        enum: ["describe", "ocr", "chart", "ui", "identify", "qa"],
        default: "describe",
        description: "Analysis mode: describe (full scene description), ocr (text extraction), chart (data/chart analysis), ui (UI screenshot analysis), identify (object/subject identification), qa (answer a specific question about the image — requires the 'question' parameter).",
      },
      question: {
        type: "string",
        description: "For mode=qa only: the specific question to answer about the image. E.g., 'What is the total revenue shown in Q3?' or 'What does the error message say?'",
        maxLength: 500,
      },
      detail: {
        type: "string",
        enum: ["low", "high", "auto"],
        default: "auto",
        description: "OpenAI vision detail level. 'auto' (default): model decides based on image size. 'low': faster, cheaper, less detail (best for simple images). 'high': slower, more detail (best for charts, dense text, complex scenes).",
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      analysis:      { type: "string",           description: "AI-generated analysis of the image based on the selected mode." },
      mode:          { type: "string",           description: "The analysis mode that was applied." },
      url:           { type: "string",           description: "The image URL that was analyzed." },
      model:         { type: "string",           description: "OpenAI model used for analysis." },
      tokens:        {
        type: "object",
        properties: {
          prompt:     { type: ["integer", "null"] },
          completion: { type: ["integer", "null"] },
          total:      { type: ["integer", "null"] },
        },
      },
      finish_reason: { type: "string",           description: "OpenAI finish reason (stop, length, content_filter)." },
    },
  },

  async handler({ url = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Bikesgray.jpg/640px-Bikesgray.jpg", mode = "describe", question, detail = "auto" }) {
    if (mode === "qa" && !question?.trim()) {
      throw new Error("mode=qa requires a 'question' parameter");
    }

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not configured");

    // Build system prompt
    let systemPrompt = ANALYSIS_MODES[mode] ?? ANALYSIS_MODES.describe;
    if (mode === "qa") {
      systemPrompt = "You are a precise visual Q&A assistant. Answer the user's question based only on what is visible in the image. Be specific, factual, and direct. If the answer is not visible, say so.";
    }

    // Build user content
    const userContent = [
      { type: "image_url", image_url: { url, detail } },
    ];
    if (mode === "qa" && question) {
      userContent.push({ type: "text", text: question });
    } else {
      const modeInstructions = {
        describe: "Describe this image in detail.",
        ocr:      "Extract all text visible in this image.",
        chart:    "Analyze this chart or graph and extract key data and insights.",
        ui:       "Analyze this UI/interface screenshot.",
        identify: "Identify the main subject(s) in this image.",
      };
      userContent.push({ type: "text", text: modeInstructions[mode] || "Describe this image." });
    }

    const body = {
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent },
      ],
      max_tokens: 800,
      temperature: 0.1,
    };

    const resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      if (resp.status === 400) {
        // Likely invalid image URL or unsupported format
        const errJson = JSON.parse(errText || "{}");
        throw new Error(`Image fetch failed: ${errJson?.error?.message || resp.status}`);
      }
      throw new Error(`OpenAI vision HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No response from vision model");

    const analysisText = choice.message?.content?.trim() ?? "";
    const usage = data.usage ?? {};

    return {
      analysis: analysisText,
      mode,
      url,
      model: data.model,
      tokens: {
        prompt: usage.prompt_tokens ?? null,
        completion: usage.completion_tokens ?? null,
        total: usage.total_tokens ?? null,
      },
      finish_reason: choice.finish_reason,
    };
  },
};
