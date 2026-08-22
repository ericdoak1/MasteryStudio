import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { LinqAPIV3 } from "@linqapp/sdk";
import type { Config, LinqReplyMode } from "./config.js";
import { fetchMemberContext } from "./member-context.js";
import { messagingPromptWithContext } from "./mastery-prompt.js";
import {
  AmbiguousVoiceDeliveryError,
  deliverLinqReply,
  transcribeLinqVoiceNote,
  type DeliveryMode,
  type DeliveryResult,
  type LinqVoiceClient
} from "./voice-notes.js";

type JsonObject = Record<string, any>;
type HeaderMap = Record<string, string | string[] | undefined>;
type ConversationMessage = { role: "user" | "assistant"; content: string };

export type LinqInboundMessage = {
  chatId: string;
  messageId: string;
  text: string;
  senderHandle?: string;
  isGroup?: boolean;
  service?: string;
  audio?: {
    filename?: string;
    mimeType?: string;
    url: string;
  };
};

export type ReplyPlan = {
  text: string;
  recommendedDelivery: DeliveryMode;
};

export type CommandCenterPurpose =
  | "welcome"
  | "reflection"
  | "insight"
  | "check_in"
  | "question"
  | "logistics";

export type CommandCenterLinqRequest = {
  chatId?: string;
  to?: string;
  text: string;
  delivery?: LinqReplyMode;
  purpose?: CommandCenterPurpose;
  introText?: string;
  includeTranscript?: boolean;
  idempotencyKey?: string;
};

export type CommandCenterLinqResult = DeliveryResult & {
  chatId: string;
  openedConversation: boolean;
  nativeVoiceBubble: boolean;
  service?: string | null;
};

type LinqChatHandle = {
  handle: string;
  is_me?: boolean | null;
  left_at?: string | null;
  status?: "active" | "left" | "removed" | null;
};

export type LinqChatSummary = {
  id: string;
  handles: LinqChatHandle[];
  is_group: boolean;
  updated_at?: string;
  service?: string | null;
  health_status?: { status?: string };
};

type LinqChatList = AsyncIterable<LinqChatSummary>;

type LinqMessagingClient = LinqVoiceClient & {
  chats: LinqVoiceClient["chats"] & {
    listChats: (query: { to: string; limit?: number }) => LinqChatList;
    retrieve: (chatId: string) => Promise<LinqChatSummary>;
    markAsRead: (chatId: string) => Promise<unknown>;
    typing: {
      start: (chatId: string) => Promise<unknown>;
      stop: (chatId: string) => Promise<unknown>;
    };
  };
  messages: {
    create: (body: {
      to: string[];
      message: { parts: Array<{ type: "text"; value: string }> };
      "Idempotency-Key"?: string;
    }) => Promise<{
      chat_id: string;
      created_new_chat: boolean;
      from: string;
      handles: LinqChatHandle[];
      is_group: boolean;
      service: string;
    }>;
  };
};

type LinqDependencies = {
  client?: LinqMessagingClient;
  fetchImplementation?: typeof fetch;
};

export class CommandCenterInputError extends Error {}

const completedEvents = new Map<string, number>();
const inFlightEvents = new Set<string>();
const conversations = new Map<string, ConversationMessage[]>();
const chatQueues = new Map<string, Promise<unknown>>();
const commandOperations = new Map<string, {
  createdAt: number;
  fingerprint: string;
  result: Promise<CommandCenterLinqResult>;
}>();
const AUTO_VOICE_PURPOSES = new Set<CommandCenterPurpose>([
  "welcome",
  "reflection",
  "insight",
  "check_in"
]);
const LINQ_OPT_OUT_COMMANDS = new Set([
  "STOP",
  "UNSUBSCRIBE",
  "OPTOUT",
  "OPT OUT",
  "OPT-OUT",
  "CANCEL",
  "END",
  "QUIT"
]);

function createLinqClient(config: Config): LinqMessagingClient {
  if (!config.linqApiToken) throw new Error("LINQ_API_TOKEN is not configured");
  return new LinqAPIV3({ apiKey: config.linqApiToken });
}

export function verifyLinqSignature(rawBody: string, headers: HeaderMap, secret?: string): boolean {
  if (!secret) return false;
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

function isAudioPart(part: JsonObject): boolean {
  const mimeType = String(part.mime_type ?? part.content_type ?? "").toLowerCase();
  if (mimeType.startsWith("audio/")) return true;
  const filename = String(part.filename ?? part.file_name ?? part.url ?? "").toLowerCase();
  return /\.(mp3|m4a|aac|caf|wav|aiff?|amr)(?:$|\?)/.test(filename);
}

export function parseLinqMessage(body: JsonObject, headers: HeaderMap): LinqInboundMessage | null {
  const eventType = body.event_type ?? body.event ?? headers["x-webhook-event"];
  const envelope = body.data ?? body.payload ?? body;
  const data = envelope.message && !envelope.parts
    ? { ...envelope, ...envelope.message }
    : envelope;
  if (eventType !== "message.received" || data.direction === "outbound" || data.reconciled_at) return null;

  const parts = Array.isArray(data.parts) ? data.parts : [];
  const text = parts
    .filter((part: JsonObject) => part.type === "text")
    .map((part: JsonObject) => part.value ?? part.text ?? "")
    .join("\n")
    .trim() || String(data.body ?? "").trim();

  const audioPart = parts.find((part: JsonObject) => part.type === "media" && isAudioPart(part));
  const audioUrl = audioPart?.url ?? audioPart?.download_url;
  const audio = audioUrl ? {
    filename: audioPart.filename ?? audioPart.file_name,
    mimeType: audioPart.mime_type ?? audioPart.content_type,
    url: String(audioUrl)
  } : undefined;

  const chatId = data.chat?.id ?? data.chat_id ?? data.chatId;
  const messageId = data.id ?? data.message_id;
  if (!chatId || !messageId || (!text && !audio)) return null;
  const senderHandle = data.sender_handle?.handle
    ?? data.from_handle?.handle
    ?? data.from
    ?? data.sender;
  const isGroup = data.chat?.is_group ?? data.is_group;
  const service = data.service ?? data.preferred_service;
  return {
    chatId: String(chatId),
    messageId: String(messageId),
    text,
    ...(senderHandle ? { senderHandle: String(senderHandle) } : {}),
    ...(typeof isGroup === "boolean" ? { isGroup } : {}),
    ...(service ? { service: String(service) } : {}),
    ...(audio ? { audio } : {})
  };
}

export function parseReplyPlan(rawReply: string, fallback: DeliveryMode = "text"): ReplyPlan {
  const clean = rawReply.trim().replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/, "").trim();
  const tag = clean.match(/^\[(text|voice)\]\s*/i);
  const text = (tag ? clean.slice(tag[0].length) : clean).trim();
  if (!text) throw new Error("OpenAI returned an empty response");
  return {
    text,
    recommendedDelivery: tag ? tag[1].toLowerCase() as DeliveryMode : fallback
  };
}

export function resolveDeliveryMode(
  config: Config,
  requestedMode: LinqReplyMode,
  recommendedMode: DeliveryMode,
  text: string
): DeliveryMode {
  const candidate = requestedMode === "auto" ? recommendedMode : requestedMode;
  if (candidate === "voice" && (!config.elevenLabsApiKey || text.length > config.linqVoiceMaxCharacters)) {
    return "text";
  }
  return candidate;
}

function liveChatHandles(chat: LinqChatSummary): LinqChatHandle[] {
  return chat.handles.filter((handle) => (
    !handle.left_at && handle.status !== "left" && handle.status !== "removed"
  ));
}

export function isDirectLinqChat(
  chat: LinqChatSummary,
  recipient?: string,
  sender?: string
): boolean {
  if (chat.is_group) return false;
  const handles = liveChatHandles(chat);
  if (handles.length !== 2 || new Set(handles.map((handle) => handle.handle)).size !== 2) {
    return false;
  }
  if (recipient && !handles.some((handle) => (
    handle.handle === recipient && handle.is_me !== true
  ))) return false;
  if (sender && !handles.some((handle) => (
    handle.handle === sender && handle.is_me !== false
  ))) return false;
  return true;
}

async function findExactDirectChat(
  client: LinqMessagingClient,
  recipient: string
): Promise<LinqChatSummary | null> {
  const matches: LinqChatSummary[] = [];
  for await (const chat of client.chats.listChats({ to: recipient, limit: 100 })) {
    if (!isDirectLinqChat(chat, recipient)) continue;
    if (chat.health_status?.status === "OPTED_OUT") continue;
    matches.push(chat);
  }
  if (matches.length > 1) {
    throw new CommandCenterInputError(
      `Multiple direct Linq chats match ${recipient}; send with the intended chatId`
    );
  }
  return matches[0] ?? null;
}

export function isLinqOptOut(text: string): boolean {
  return LINQ_OPT_OUT_COMMANDS.has(text.trim().toUpperCase());
}

function replyIdempotencyKey(messageId: string): string {
  return `emma-reply-${createHash("sha256").update(messageId).digest("hex")}`;
}

function commandProviderKey(idempotencyKey: string, phase: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return `emma-${phase}-${digest}`;
}

async function generateReply(
  config: Config,
  chatId: string,
  text: string,
  source: "text" | "voice",
  fetchImplementation: typeof fetch,
  memberContext: Record<string, unknown> = {}
): Promise<{ plan: ReplyPlan; nextHistory: ConversationMessage[] }> {
  const history = conversations.get(chatId) ?? [];
  const input = [...history.slice(-10), { role: "user" as const, content: text }];
  const sourceInstruction = source === "voice"
    ? "The member sent a voice note. Prefer replying with a voice note unless written text would clearly work better."
    : "The member sent a written message.";
  const response = await fetchImplementation("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openAiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.openAiTextModel,
      store: false,
      instructions: `${messagingPromptWithContext(memberContext)}

Keep the reply concise and conversational. Do not use markdown headings.
Start the response with exactly [text] or [voice]. This tag is hidden before delivery.
Use [voice] selectively for a warm welcome, a meaningful reflection, a key insight, or a personal check-in. A voice reply must be natural spoken language with no URLs, markdown, or list formatting, no more than one question, and roughly 45 to 90 words. Use [text] for logistics, links, dates, lists, or anything the member needs to scan.
${sourceInstruction}`,
      input
    }),
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) throw new Error(`OpenAI Responses returned ${response.status}: ${await response.text()}`);
  const result = await response.json() as JsonObject;
  const rawReply = String(result.output_text ?? result.output?.flatMap((item: JsonObject) => item.content ?? [])
    .filter((part: JsonObject) => part.type === "output_text")
    .map((part: JsonObject) => part.text)
    .join("\n") ?? "").trim();
  const plan = parseReplyPlan(rawReply, source === "voice" ? "voice" : "text");
  return {
    plan,
    nextHistory: [...input, { role: "assistant" as const, content: plan.text }].slice(-12)
  };
}

function purgeCompletedEvents(now: number): void {
  for (const [id, time] of completedEvents) {
    if (now - time > 60 * 60 * 1000) completedEvents.delete(id);
  }
}

async function withChatLock<T>(chatId: string, task: () => Promise<T>): Promise<T> {
  const previous = chatQueues.get(chatId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  chatQueues.set(chatId, current);
  try {
    return await current;
  } finally {
    if (chatQueues.get(chatId) === current) chatQueues.delete(chatId);
  }
}

export async function processLinqMessage(
  config: Config,
  message: LinqInboundMessage,
  dependencies: LinqDependencies = {}
): Promise<void> {
  const now = Date.now();
  purgeCompletedEvents(now);
  if (completedEvents.has(message.messageId) || inFlightEvents.has(message.messageId)) return;
  inFlightEvents.add(message.messageId);
  try {
    await withChatLock(message.chatId, async () => {
      if (completedEvents.has(message.messageId)) return;
      const fetchImplementation = dependencies.fetchImplementation ?? fetch;
      const client = dependencies.client ?? createLinqClient(config);
      if (isLinqOptOut(message.text)) {
        completedEvents.set(message.messageId, Date.now());
        return;
      }
      await Promise.allSettled([
        client.chats.markAsRead(message.chatId),
        client.chats.typing.start(message.chatId)
      ]);

      try {
        let chatMetadata: LinqChatSummary | undefined;
        if (message.isGroup === undefined) {
          chatMetadata = await client.chats.retrieve(message.chatId).catch((error) => {
            console.warn("Could not verify Linq chat type; voice and private context are disabled:", error);
            return undefined;
          });
        }
        if (message.isGroup === true || chatMetadata?.is_group === true) {
          completedEvents.set(message.messageId, Date.now());
          return;
        }
        const isDirectChat = message.isGroup === false
          || (chatMetadata ? isDirectLinqChat(chatMetadata) : false);
        let inboundText = message.text;
        let source: "text" | "voice" = "text";
        if (message.audio) {
          source = "voice";
          try {
            const transcript = await transcribeLinqVoiceNote(config, message.audio.url, fetchImplementation);
            inboundText = [inboundText, transcript].filter(Boolean).join("\n");
          } catch (error) {
            if (inboundText) {
              console.warn("Voice-note transcription failed; continuing with attached text:", error);
            } else {
              console.warn("Voice-note transcription failed:", error);
              await deliverLinqReply(
                config,
                client,
                message.chatId,
                "I couldn't make out that voice note. Send it one more time or type it here.",
                "text",
                { idempotencyKey: replyIdempotencyKey(message.messageId) }
              );
              completedEvents.set(message.messageId, Date.now());
              return;
            }
          }
        }

        const memberContext = isDirectChat
          ? await fetchMemberContext(config, message.senderHandle, fetchImplementation)
          : {};
        const { plan, nextHistory } = await generateReply(
          config,
          message.chatId,
          inboundText,
          source,
          fetchImplementation,
          memberContext
        );
        let delivery = resolveDeliveryMode(
          config,
          config.linqReplyMode,
          plan.recommendedDelivery,
          plan.text
        );
        if (delivery === "voice" && !isDirectChat) delivery = "text";
        await deliverLinqReply(config, client, message.chatId, plan.text, delivery, {
          includeTranscript: config.linqVoiceSendTranscript,
          fetchImplementation,
          idempotencyKey: replyIdempotencyKey(message.messageId)
        });
        conversations.set(message.chatId, nextHistory);
        completedEvents.set(message.messageId, Date.now());
      } finally {
        await client.chats.typing.stop(message.chatId).catch(() => undefined);
      }
    });
  } finally {
    inFlightEvents.delete(message.messageId);
  }
}

function validateCommandCenterRequest(request: CommandCenterLinqRequest): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new CommandCenterInputError("Request body must be a JSON object");
  }
  const stringFields: Array<keyof Pick<
    CommandCenterLinqRequest,
    "chatId" | "to" | "text" | "introText" | "idempotencyKey"
  >> = ["chatId", "to", "text", "introText", "idempotencyKey"];
  for (const field of stringFields) {
    if (request[field] !== undefined && typeof request[field] !== "string") {
      throw new CommandCenterInputError(`${field} must be a string`);
    }
  }
  if (request.includeTranscript !== undefined && typeof request.includeTranscript !== "boolean") {
    throw new CommandCenterInputError("includeTranscript must be true or false");
  }
  const hasChatId = Boolean(request.chatId?.trim());
  const hasRecipient = Boolean(request.to?.trim());
  if (hasChatId === hasRecipient) {
    throw new CommandCenterInputError("Provide exactly one of chatId or to");
  }
  if (!request.text?.trim()) throw new CommandCenterInputError("text is required");
  if (!request.idempotencyKey?.trim()) {
    throw new CommandCenterInputError("idempotencyKey is required");
  }
  if (request.idempotencyKey.trim().length > 200) {
    throw new CommandCenterInputError("idempotencyKey must be 200 characters or fewer");
  }
  if (request.to && !/^\+[1-9]\d{7,14}$/.test(request.to.trim())) {
    throw new CommandCenterInputError("to must be an E.164 phone number");
  }
  if (request.delivery !== undefined && (
    typeof request.delivery !== "string"
    || !["text", "voice", "auto"].includes(request.delivery)
  )) {
    throw new CommandCenterInputError("delivery must be text, voice, or auto");
  }
  if (request.purpose !== undefined && (
    typeof request.purpose !== "string"
    || ![
      "welcome",
      "reflection",
      "insight",
      "check_in",
      "question",
      "logistics"
    ].includes(request.purpose)
  )) {
    throw new CommandCenterInputError("purpose is invalid");
  }
}

function recommendedCommandCenterDelivery(request: CommandCenterLinqRequest): DeliveryMode {
  return request.purpose && AUTO_VOICE_PURPOSES.has(request.purpose) ? "voice" : "text";
}

async function executeCommandCenterLinqMessage(
  config: Config,
  request: CommandCenterLinqRequest,
  dependencies: LinqDependencies = {}
): Promise<CommandCenterLinqResult> {
  const client = dependencies.client ?? createLinqClient(config);
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const text = request.text.trim();
  const operationKey = request.idempotencyKey!.trim();
  const requestedMode = request.delivery ?? "text";
  const recommendedMode = recommendedCommandCenterDelivery(request);
  const delivery = resolveDeliveryMode(
    config,
    requestedMode,
    recommendedMode,
    text
  );
  const downgradedToText = delivery === "text"
    && (requestedMode === "voice" || (requestedMode === "auto" && recommendedMode === "voice"));

  if (request.chatId) {
    const chatId = request.chatId.trim();
    let service: string | null | undefined;
    if (delivery === "voice") {
      const chat = await client.chats.retrieve(chatId);
      if (!isDirectLinqChat(chat)) {
        throw new CommandCenterInputError("Emma voice notes can only be sent to a direct chat");
      }
      service = chat.service;
    }
    const result = await deliverLinqReply(config, client, request.chatId.trim(), text, delivery, {
      includeTranscript: request.includeTranscript ?? config.linqVoiceSendTranscript,
      fetchImplementation,
      idempotencyKey: commandProviderKey(operationKey, "reply")
    });
    return {
      ...result,
      fellBackToText: result.fellBackToText || downgradedToText,
      chatId,
      openedConversation: false,
      nativeVoiceBubble: result.delivery === "voice" && service === "iMessage",
      ...(service !== undefined ? { service } : {})
    };
  }

  const to = request.to!.trim();
  if (delivery === "text") {
    const result = await client.messages.create({
      to: [to],
      message: { parts: [{ type: "text", value: text }] },
      "Idempotency-Key": commandProviderKey(operationKey, "text")
    });
    return {
      chatId: result.chat_id,
      delivery: "text",
      fellBackToText: downgradedToText,
      openedConversation: result.created_new_chat,
      nativeVoiceBubble: false,
      service: result.service
    };
  }

  const existingChat = await findExactDirectChat(client, to);
  if (existingChat) {
    const result = await deliverLinqReply(config, client, existingChat.id, text, "voice", {
      includeTranscript: request.includeTranscript ?? config.linqVoiceSendTranscript,
      fetchImplementation,
      idempotencyKey: commandProviderKey(operationKey, "reply")
    });
    return {
      ...result,
      chatId: existingChat.id,
      openedConversation: false,
      nativeVoiceBubble: result.delivery === "voice" && existingChat.service === "iMessage",
      service: existingChat.service
    };
  }

  // Linq requires a known chat ID for a native voice memo. True first contact opens
  // with a short identification text and then sends Emma's voice note.
  const opener = request.introText?.trim() || "Hi, it's Emma from Mastery.";
  const opened = await client.messages.create({
    to: [to],
    message: { parts: [{ type: "text", value: opener }] },
    "Idempotency-Key": commandProviderKey(operationKey, "opener")
  });
  if (!isDirectLinqChat({
    id: opened.chat_id,
    handles: opened.handles,
    is_group: opened.is_group,
    service: opened.service
  }, to, opened.from)) {
    throw new Error("Linq did not resolve a safe direct chat for the voice note");
  }
  const result = await deliverLinqReply(config, client, opened.chat_id, text, "voice", {
    includeTranscript: request.includeTranscript ?? config.linqVoiceSendTranscript,
    fetchImplementation,
    idempotencyKey: commandProviderKey(operationKey, "reply")
  });
  return {
    ...result,
    chatId: opened.chat_id,
    openedConversation: opened.created_new_chat,
    nativeVoiceBubble: result.delivery === "voice" && opened.service === "iMessage",
    service: opened.service
  };
}

function commandRequestFingerprint(request: CommandCenterLinqRequest): string {
  return createHash("sha256").update(JSON.stringify({
    chatId: request.chatId?.trim() || null,
    to: request.to?.trim() || null,
    text: request.text.trim(),
    delivery: request.delivery ?? "text",
    purpose: request.purpose ?? null,
    introText: request.introText?.trim() || null,
    includeTranscript: request.includeTranscript ?? null
  })).digest("hex");
}

function purgeCommandOperations(now: number): void {
  for (const [key, operation] of commandOperations) {
    if (now - operation.createdAt > 24 * 60 * 60 * 1000) commandOperations.delete(key);
  }
}

export async function sendCommandCenterLinqMessage(
  config: Config,
  request: CommandCenterLinqRequest,
  dependencies: LinqDependencies = {}
): Promise<CommandCenterLinqResult> {
  validateCommandCenterRequest(request);
  const idempotencyKey = request.idempotencyKey!.trim();
  const fingerprint = commandRequestFingerprint(request);
  purgeCommandOperations(Date.now());

  const existing = commandOperations.get(idempotencyKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new CommandCenterInputError("idempotencyKey was already used for a different request");
    }
    return existing.result;
  }

  const result = executeCommandCenterLinqMessage(config, request, dependencies);
  commandOperations.set(idempotencyKey, {
    createdAt: Date.now(),
    fingerprint,
    result
  });
  void result.catch((error) => {
    if (!(error instanceof AmbiguousVoiceDeliveryError)
      && commandOperations.get(idempotencyKey)?.result === result) {
      commandOperations.delete(idempotencyKey);
    }
  });
  return result;
}
