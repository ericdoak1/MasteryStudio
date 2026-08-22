import type { Config } from "./config.js";

type Subscription = { id: string; target_url?: string; signing_secret?: string; is_active?: boolean };
const LINQ_API = "https://api.linqapp.com/api/partner/v3";

async function linq(config: Config, path: string, init: RequestInit = {}) {
  if (!config.linqApiToken) throw new Error("LINQ_API_TOKEN is not configured");
  const response = await fetch(`${LINQ_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.linqApiToken}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    },
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let value: any = text;
  try { value = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(`Linq API ${response.status}: ${typeof value === "string" ? value.slice(0,300) : JSON.stringify(value).slice(0,300)}`);
  return value;
}

export async function ensureLinqWebhook(config: Config): Promise<{ signingSecret?: string; subscriptionId?: string; targetUrl?: string }> {
  if (!config.linqApiToken || !config.publicBaseUrl) return {};
  const targetUrl = `${config.publicBaseUrl}/linq/webhook?version=2026-02-03`;
  const listed = await linq(config, "/webhook-subscriptions");
  const items: Subscription[] = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : Array.isArray(listed?.items) ? listed.items : [];
  for (const sub of items) {
    if (sub?.target_url === targetUrl && sub?.id) {
      await linq(config, `/webhook-subscriptions/${encodeURIComponent(sub.id)}`, { method: "DELETE" }).catch(() => undefined);
    }
  }
  const created = await linq(config, "/webhook-subscriptions", {
    method: "POST",
    body: JSON.stringify({
      target_url: targetUrl,
      subscribed_events: ["message.received"]
    })
  });
  const sub = (created?.data ?? created) as Subscription;
  return { signingSecret: sub?.signing_secret, subscriptionId: sub?.id, targetUrl };
}
