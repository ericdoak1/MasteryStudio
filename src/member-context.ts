import type { Config } from "./config.js";

const MAX_CONTEXT_BYTES = 256 * 1024;
const SENSITIVE_CONTEXT_KEY = /(^|_)(password|secret|token|api_key|authorization|credential|cookie|private_key|ssn)($|_)/;

function safeContextValue(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null) return value;
  if (typeof value === "string") return value.slice(0, 8000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => safeContextValue(item, depth + 1));
  }
  if (typeof value !== "object") return undefined;

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 200)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (SENSITIVE_CONTEXT_KEY.test(normalizedKey)) continue;
    const safeValue = safeContextValue(nested, depth + 1);
    if (safeValue !== undefined) clean[key] = safeValue;
  }
  return clean;
}

async function fetchContextEndpoint(
  endpoint: string,
  token: string | undefined,
  phone: string,
  fetchImplementation: typeof fetch
): Promise<Record<string, unknown>> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("context endpoint must use HTTPS");
  url.searchParams.set("phone", phone);
  url.searchParams.set("scope", "studio");
  url.searchParams.set("include", "all");

  const response = await fetchImplementation(url, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`context endpoint returned ${response.status}`);

  const rawContext = await response.text();
  if (Buffer.byteLength(rawContext, "utf8") > MAX_CONTEXT_BYTES) {
    throw new Error("context endpoint returned more than 256 KB");
  }

  const parsed = JSON.parse(rawContext) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("context endpoint must return a JSON object");
  }
  return safeContextValue(parsed) as Record<string, unknown>;
}

export async function fetchMemberContext(
  config: Config,
  phone?: string,
  fetchImplementation: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  if (!phone) return {};

  const endpoint = config.masteryStudioContextUrl ?? config.masteryProfileUrl;
  const token = config.masteryStudioContextUrl
    ? config.masteryStudioContextToken ?? config.masteryProfileToken
    : config.masteryProfileToken;
  if (!endpoint) return {};

  try {
    return await fetchContextEndpoint(endpoint, token, phone, fetchImplementation);
  } catch (error) {
    console.warn("Mastery Studio context unavailable:", error);
    return {};
  }
}
