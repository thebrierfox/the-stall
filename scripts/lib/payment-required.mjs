// Extract native x402 MCP PaymentRequired across the result shapes used by
// current and transitional @x402/mcp / MCP SDK combinations.
export function extractPaymentRequired(result) {
  const direct = result?.structuredContent;
  if (Array.isArray(direct?.accepts)) return direct;
  if (Array.isArray(direct?.["x402/error"]?.data?.accepts)) {
    return direct["x402/error"].data;
  }
  if (direct?.error?.code === 402 && Array.isArray(direct.error?.data?.accepts)) {
    return direct.error.data;
  }

  for (const item of result?.content || []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    let parsed;
    try { parsed = JSON.parse(item.text); } catch { continue; }
    if (Array.isArray(parsed?.accepts)) return parsed;
    if (Array.isArray(parsed?.["x402/error"]?.data?.accepts)) {
      return parsed["x402/error"].data;
    }
    if (parsed?.error?.code === 402 && Array.isArray(parsed.error?.data?.accepts)) {
      return parsed.error.data;
    }
  }
  return null;
}
