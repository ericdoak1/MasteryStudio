import { createHash, randomUUID } from "node:crypto";
import type { Config } from "./config.js";

type FetchImplementation = typeof fetch;

type AttachmentSlot = {
  attachment_id: string;
  http_method: "PUT";
  required_headers: Record<string, string>;
  upload_url: string;
};

export type LinqVoiceClient = {
  attachments: {
    create: (
      body: { content_type: "audio/mpeg"; filename: string; size_bytes: number },
      options?: { maxRetries?: number }
    ) => Promise<AttachmentSlot>;
    delete?: (attachmentId: string, options?: { maxRetries?: number }) => Promise<unknown>;
  };
  chats: {
    messages: {
      send: (
        chatId: string,
        body: {
          message: {
            idempotency_key?: string;
            parts: Array<{ type: "text"; value: string }>;
          };
        },
        options?: { maxRetries?: number }
      ) => Promise<unknown>;
    };
    sendVoicememo: (
      chatId: string,
      body: { attachment_id: string },
      options?: { maxRetries?: number }
    ) => Promise<unknown>;
  };
};

export type DeliveryMode = "text" | "voice";

export type DeliveryResult = {
  delivery: DeliveryMode;
  fellBackToText: boolean;
};

export class AmbiguousVoiceDeliveryError extends Error {
  constructor(cause: unknown) {
    super("Linq voice-note delivery could not be confirmed", { cause });
    this.name = "AmbiguousVoiceDeliveryError";
  }
}

export const MAX_NATIVE_VOICE_MEMO_BYTES = 10 * 1024 * 1024;
const ELEVENLABS_TTS_OUTPUT_FORMAT = "mp3_44100_128";

function requireElevenLabs(config: Config): string {
  if (!config.elevenLabsApiKey) throw new Error("ELEVENLABS_API_KEY is not configured");
  return config.elevenLabsApiKey;
}

async function responseError(provider: string, response: Response): Promise<Error> {
  const detail = (await response.text()).slice(0, 1000);
  return new Error(`${provider} returned ${response.status}${detail ? `: ${detail}` : ""}`);
}

export async function synthesizeEmmaVoiceNote(
  config: Config,
  text: string,
  fetchImplementation: FetchImplementation = fetch
): Promise<Uint8Array> {
  const apiKey = requireElevenLabs(config);
  const cleanText = text.trim();
  if (!cleanText) throw new Error("Voice-note text cannot be empty");

  const url = new URL(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenLabsVoiceId)}`
  );
  url.searchParams.set("output_format", ELEVENLABS_TTS_OUTPUT_FORMAT);
  url.searchParams.set("enable_logging", String(config.elevenLabsEnableLogging));

  const response = await fetchImplementation(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey
    },
    body: JSON.stringify({
      text: cleanText,
      model_id: config.elevenLabsTtsModel
    }),
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) throw await responseError("ElevenLabs text-to-speech", response);
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType && !contentType.startsWith("audio/") && !contentType.includes("octet-stream")) {
    throw new Error(`ElevenLabs returned unexpected content type: ${contentType}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_NATIVE_VOICE_MEMO_BYTES) {
    throw new Error("Generated voice note exceeds Linq's 10 MB limit");
  }

  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength === 0) throw new Error("ElevenLabs returned empty audio");
  if (audio.byteLength > MAX_NATIVE_VOICE_MEMO_BYTES) {
    throw new Error("Generated voice note exceeds Linq's 10 MB limit");
  }
  return audio;
}

export async function transcribeLinqVoiceNote(
  config: Config,
  sourceUrl: string,
  fetchImplementation: FetchImplementation = fetch
): Promise<string> {
  const apiKey = requireElevenLabs(config);
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:") throw new Error("Voice-note source URL must use HTTPS");

  const form = new FormData();
  form.set("model_id", config.elevenLabsSttModel);
  form.set("source_url", url.toString());
  form.set("tag_audio_events", "false");
  form.set("no_verbatim", "true");

  const speechToTextUrl = new URL("https://api.elevenlabs.io/v1/speech-to-text");
  speechToTextUrl.searchParams.set("enable_logging", String(config.elevenLabsEnableLogging));
  const response = await fetchImplementation(speechToTextUrl, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw await responseError("ElevenLabs speech-to-text", response);

  const result = await response.json() as { text?: string };
  const transcript = result.text?.trim() ?? "";
  if (!transcript) throw new Error("ElevenLabs returned an empty transcript");
  return transcript;
}

export async function sendLinqText(
  client: LinqVoiceClient,
  chatId: string,
  text: string,
  idempotencyKey?: string
): Promise<void> {
  await client.chats.messages.send(chatId, {
    message: {
      parts: [{ type: "text", value: text }],
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
    }
  });
}

function transcriptIdempotencyKey(idempotencyKey: string | undefined): string | undefined {
  if (!idempotencyKey) return undefined;
  return `transcript-${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

export async function sendLinqVoiceNoteBytes(
  client: LinqVoiceClient,
  chatId: string,
  audio: Uint8Array,
  fetchImplementation: FetchImplementation = fetch
): Promise<void> {
  if (audio.byteLength === 0) throw new Error("Voice-note audio cannot be empty");
  if (audio.byteLength > MAX_NATIVE_VOICE_MEMO_BYTES) {
    throw new Error("Voice note exceeds Linq's 10 MB limit");
  }

  const attachment = await client.attachments.create({
    content_type: "audio/mpeg",
    filename: `emma-${randomUUID()}.mp3`,
    size_bytes: audio.byteLength
  }, { maxRetries: 0 });

  const exactBody = audio.buffer.slice(
    audio.byteOffset,
    audio.byteOffset + audio.byteLength
  ) as ArrayBuffer;
  let upload: Response;
  try {
    upload = await fetchImplementation(attachment.upload_url, {
      method: attachment.http_method,
      headers: attachment.required_headers,
      body: exactBody,
      signal: AbortSignal.timeout(45_000)
    });
  } catch (error) {
    await client.attachments.delete?.(attachment.attachment_id, { maxRetries: 0 }).catch(() => undefined);
    throw error;
  }
  if (!upload.ok) {
    await client.attachments.delete?.(attachment.attachment_id, { maxRetries: 0 }).catch(() => undefined);
    throw await responseError("Linq attachment upload", upload);
  }

  // Linq does not document idempotency for native voice memos. Disable SDK retries
  // so an ambiguous network response cannot produce a duplicate audio bubble.
  try {
    await client.chats.sendVoicememo(
      chatId,
      { attachment_id: attachment.attachment_id },
      { maxRetries: 0 }
    );
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
    const isDefiniteRejection = status !== undefined
      && status >= 400
      && status < 500
      && status !== 408
      && status !== 409;
    if (isDefiniteRejection) {
      await client.attachments.delete?.(attachment.attachment_id, { maxRetries: 0 }).catch(() => undefined);
      throw error;
    }
    throw new AmbiguousVoiceDeliveryError(error);
  }
}

export async function deliverLinqReply(
  config: Config,
  client: LinqVoiceClient,
  chatId: string,
  text: string,
  mode: DeliveryMode,
  options: {
    includeTranscript?: boolean;
    fetchImplementation?: FetchImplementation;
    idempotencyKey?: string;
  } = {}
): Promise<DeliveryResult> {
  const cleanText = text.trim();
  if (!cleanText) throw new Error("Reply text cannot be empty");
  if (mode === "text") {
    await sendLinqText(client, chatId, cleanText, options.idempotencyKey);
    return { delivery: "text", fellBackToText: false };
  }

  try {
    const audio = await synthesizeEmmaVoiceNote(
      config,
      cleanText,
      options.fetchImplementation
    );
    await sendLinqVoiceNoteBytes(client, chatId, audio, options.fetchImplementation);
  } catch (error) {
    if (error instanceof AmbiguousVoiceDeliveryError) throw error;
    console.warn("Native voice-note delivery failed; sending text instead:", error);
    await sendLinqText(client, chatId, cleanText, options.idempotencyKey);
    return { delivery: "text", fellBackToText: true };
  }

  if (options.includeTranscript) {
    await sendLinqText(
      client,
      chatId,
      cleanText,
      transcriptIdempotencyKey(options.idempotencyKey)
    ).catch((error) => {
      console.warn("Voice note sent, but transcript delivery failed:", error);
    });
  }
  return { delivery: "voice", fellBackToText: false };
}
