import { createHmac, timingSafeEqual } from "node:crypto";
import { LinqAPIV3 } from "@linqapp/sdk";
import type { Config } from "./config.js";
import { MASTERY_PROMPT } from "./mastery-prompt.js";

type JsonObject = Record<string, any>;
type HeaderMap = Record<string, string | string[] | undefined>;

const seenEvents = new Map<string, number>();
const conversations = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();

export function verifyLinqSignature(rawBody: string, headers: HeaderMap, secret?: string): boolean {
  if (!secret) return true;
  const id = String(headers["webhook-id"] ?? "");
  const timestamp = String(headers["webhook-timestamp"] ?? "");
  const signature = String(headers["webhook-signature"] ?? "");
  if (!id || !timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(encodedSecret, "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest();

  return signature.split(" ").some((candidate) => {
    if (!candidate.startsWith("v1,")) return false;
    try {
      const received = Buffer.from(candidate.slice(3), "base64");
      return received.length === expected.length && timingSafeEqual(received, expected);
    } catch {
      return false;
    }
  });
}

export function parseLinqMessage(body: JsonObject, headers: HeaderMap) {
  const eventType = body.event_type ?? body.event ?? headers["x-webhook-event"];
  const data = body.data ?? body.payload ?? body;
  if (eventType !== "message.received" || data.direction === "outbound" || data.reconciled_at) return null;

  const text = (data.parts ?? [])
    .filter((part: JsonObject) => part.type === "text")
    .map((part: JsonObject) => part.value ?? part.text ?? "")
    .join("\n")
    .trim() || String(data.body ?? "").trim();

  const chatId = data.chat?.id ?? data.chat_id ?? data.chatId;
  const messageId = data.id ?? data.message?.id;
  if (!chatId || !messageId || !text) return null;
  return { chatId: String(chatId), messageId: String(messageId), text };
}

async function generateReply(config: Config, chatId: string, text: string): Promise<string> {
  const history = conversations.get(chatId) ?? [];
  const input = [...history.slice(-10), { role: "user" as const, content: text }];
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openAiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.openAiTextModel,
      instructions: `${MASTERY_PROMPT}\n\nYou are replying by iMessage. Keep the reply concise and conversational. Do not use markdown headings.`,
      input
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw new Error(`OpenAI Responses returned ${response.status}: ${await response.text()}`);
  const result = await response.json() as JsonObject;
  const reply = String(result.output_text ?? result.output?.flatMap((item: JsonObject) => item.content ?? [])
    .filter((part: JsonObject) => part.type === "output_text")
    .map((part: JsonObject) => part.text)
    .join("\n") ?? "").trim();
  if (!reply) throw new Error("OpenAI returned an empty response");
  conversations.set(chatId, [...input, { role: "assistant" as const, content: reply }].slice(-12));
  return reply;
}

export async function processLinqMessage(config: Config, message: { chatId: string; messageId: string; text: string }) {
  if (!config.linqApiToken) throw new Error("LINQ_API_TOKEN is not configured");
  const now = Date.now();
  for (const [id, time] of seenEvents) if (now - time > 60 * 60 * 1000) seenEvents.delete(id);
  if (seenEvents.has(message.messageId)) return;
  seenEvents.set(message.messageId, now);

  const client = new LinqAPIV3({ apiKey: config.linqApiToken });
  await Promise.allSettled([
    client.chats.markAsRead(message.chatId),
    client.chats.typing.start(message.chatId)
  ]);
  try {
    const reply = await generateReply(config, message.chatId, message.text);
    await client.chats.messages.send(message.chatId, {
      message: { parts: [{ type: "text", value: reply }] }
    });
  } finally {
    await client.chats.typing.stop(message.chatId).catch(() => undefined);
  }
}
