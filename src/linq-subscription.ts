import type { Config } from "./config.js";

type Subscription = {
  id: string;
  target_url?: string;
  signing_secret?: string;
  is_active?: boolean;
  subscribed_events?: string[];
  phone_numbers?: string[] | null;
};
type PhoneNumber = { id?: string; phone_number?: string };
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

function subscriptionsFrom(value: any): Subscription[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.subscriptions)) return value.subscriptions;
  if (Array.isArray(value?.data?.subscriptions)) return value.data.subscriptions;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function phoneNumbersFrom(value: any): string[] {
  const items: PhoneNumber[] = Array.isArray(value?.phone_numbers)
    ? value.phone_numbers
    : Array.isArray(value?.data?.phone_numbers)
      ? value.data.phone_numbers
      : [];
  return items.map((item) => item.phone_number).filter((value): value is string => Boolean(value));
}

function receivesMessages(sub: Subscription): boolean {
  return sub.is_active !== false && (sub.subscribed_events ?? []).includes("message.received");
}

async function removeMasteryLineFromOtherSubscriptions(
  config: Config,
  subscriptions: Subscription[],
  targetUrl: string,
  masteryLine: string
): Promise<void> {
  let allLines: string[] = [];
  try { allLines = phoneNumbersFrom(await linq(config, "/phone_numbers")); } catch (error) {
    console.warn("Could not list Linq phone numbers; leaving broad legacy subscriptions unchanged:", error);
  }

  for (const sub of subscriptions) {
    if (!sub.id || sub.target_url === targetUrl || !receivesMessages(sub)) continue;
    const scoped = Array.isArray(sub.phone_numbers) && sub.phone_numbers.length > 0;
    if (scoped && !sub.phone_numbers!.includes(masteryLine)) continue;
    if (!scoped && allLines.length === 0) continue;

    const remaining = scoped
      ? sub.phone_numbers!.filter((number) => number !== masteryLine)
      : allLines.filter((number) => number !== masteryLine);

    if (remaining.length === 0) {
      await linq(config, `/webhook-subscriptions/${encodeURIComponent(sub.id)}`, { method: "DELETE" });
      continue;
    }

    await linq(config, `/webhook-subscriptions/${encodeURIComponent(sub.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        target_url: sub.target_url,
        subscribed_events: sub.subscribed_events,
        phone_numbers: remaining,
        is_active: sub.is_active !== false
      })
    });
  }
}

export async function ensureLinqWebhook(config: Config): Promise<{ signingSecret?: string; subscriptionId?: string; targetUrl?: string }> {
  if (!config.linqApiToken || !config.publicBaseUrl) return {};
  const targetUrl = `${config.publicBaseUrl}/linq/webhook?version=2026-02-03`;
  const masteryLine = config.linqPhoneNumber;
  const listed = await linq(config, "/webhook-subscriptions");
  const items = subscriptionsFrom(listed);

  if (masteryLine) {
    await removeMasteryLineFromOtherSubscriptions(config, items, targetUrl, masteryLine);
  }

  // Recreate our subscription on every deploy. Linq only exposes the signing
  // secret at creation time, so rotating here guarantees this process always
  // verifies against the secret for the webhook it owns.
  for (const sub of items) {
    if (sub?.target_url === targetUrl && sub?.id) {
      await linq(config, `/webhook-subscriptions/${encodeURIComponent(sub.id)}`, { method: "DELETE" });
    }
  }

  const created = await linq(config, "/webhook-subscriptions", {
    method: "POST",
    body: JSON.stringify({
      target_url: targetUrl,
      subscribed_events: ["message.received"],
      ...(masteryLine ? { phone_numbers: [masteryLine] } : {})
    })
  });
  const sub = (created?.data ?? created) as Subscription;
  if (!sub?.id || !sub?.signing_secret) throw new Error("Linq created webhook without id/signing secret");
  return { signingSecret: sub.signing_secret, subscriptionId: sub.id, targetUrl };
}
