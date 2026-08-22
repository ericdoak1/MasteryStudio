import type { Config } from "./config.js";

const MAX_CONTEXT_BYTES = 64 * 1024;
const SENSITIVE_CONTEXT_KEY = /(^|_)(password|secret|token|api_key|authorization|credential|cookie|private_key|ssn)($|_)/;

function safeContextValue(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null) return value;
  if (typeof value === "string") return value.slice(0, 2000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => safeContextValue(item, depth + 1));
  }
  if (typeof value !== "object") return undefined;

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 50)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (SENSITIVE_CONTEXT_KEY.test(normalizedKey)) continue;
    const safeValue = safeContextValue(nested, depth + 1);
    if (safeValue !== undefined) clean[key] = safeValue;
  }
  return clean;
}

export async function fetchMemberContext(
  config: Config,
  phone?: string,
  fetchImplementation: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  if (!config.masteryProfileUrl || !phone) return {};
  try {
    const url = new URL(config.masteryProfileUrl);
    if (url.protocol !== "https:") throw new Error("profile endpoint must use HTTPS");
    url.searchParams.set("phone", phone);
    const response = await fetchImplementation(url, {
      headers: config.masteryProfileToken
        ? { authorization: `Bearer ${config.masteryProfileToken}` }
        : undefined,
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) throw new Error(`profile endpoint returned ${response.status}`);
    const rawContext = await response.text();
    if (Buffer.byteLength(rawContext, "utf8") > MAX_CONTEXT_BYTES) {
      throw new Error("profile endpoint returned more than 64 KB");
    }
    const parsed = JSON.parse(rawContext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("profile endpoint must return a JSON object");
    }
    return safeContextValue(parsed) as Record<string, unknown>;
  } catch (error) {
    console.warn("Member context unavailable:", error);
    return {};
  }
}
