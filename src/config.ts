export type LinqReplyMode = "text" | "voice" | "auto";

export type Config = {
  port: number;
  publicBaseUrl: string;
  openAiApiKey: string;
  openAiModel: string;
  openAiVoice: string;
  databaseUrl?: string;
  renderApiKey?: string;
  renderServiceId?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  outboundApiKey?: string;
  masteryProfileUrl?: string;
  masteryProfileToken?: string;
  masteryStudioContextUrl?: string;
  masteryStudioContextToken?: string;
  linqApiToken?: string;
  linqWebhookSecret?: string;
  linqPhoneNumber?: string;
  linqReplyMode: LinqReplyMode;
  linqVoiceSendTranscript: boolean;
  linqVoiceMaxCharacters: number;
  openAiTextModel: string;
  elevenLabsApiKey?: string;
  elevenLabsEnableLogging: boolean;
  elevenLabsVoiceId: string;
  elevenLabsTtsModel: string;
  elevenLabsSttModel: string;
};

function parseReplyMode(value: string | undefined): LinqReplyMode {
  const mode = value?.trim().toLowerCase() || "text";
  if (mode === "text" || mode === "voice" || mode === "auto") return mode;
  throw new Error("LINQ_REPLY_MODE must be text, voice, or auto");
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") return fallback;
  if (value.trim().toLowerCase() === "true") return true;
  if (value.trim().toLowerCase() === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.OPENAI_API_KEY) throw new Error("Missing required environment variable: OPENAI_API_KEY");
  const renderHost = env.RENDER_EXTERNAL_HOSTNAME?.trim();
  const configuredBase = env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  const base = renderHost ? `https://${renderHost}` : configuredBase;
  if (!base || !base.startsWith("https://")) throw new Error("A valid HTTPS public base URL is required");
  return {
    port: Number(env.PORT ?? 3000), publicBaseUrl: base,
    openAiApiKey: env.OPENAI_API_KEY!, openAiModel: env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1", openAiVoice: env.OPENAI_VOICE ?? "marin",
    databaseUrl: env.DATABASE_URL || undefined,
    renderApiKey: env.RENDER_API_KEY || undefined,
    renderServiceId: env.RENDER_SERVICE_ID || "srv-da3o9l8u01pc73c2ggvg",
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || undefined, twilioAuthToken: env.TWILIO_AUTH_TOKEN || undefined, twilioFromNumber: env.TWILIO_FROM_NUMBER || undefined,
    outboundApiKey: env.OUTBOUND_API_KEY || undefined,
    masteryProfileUrl: env.MASTERY_PROFILE_URL || undefined, masteryProfileToken: env.MASTERY_PROFILE_TOKEN || undefined,
    masteryStudioContextUrl: env.MASTERY_STUDIO_CONTEXT_URL || undefined, masteryStudioContextToken: env.MASTERY_STUDIO_CONTEXT_TOKEN || undefined,
    linqApiToken: env.LINQ_API_TOKEN || undefined, linqWebhookSecret: env.LINQ_WEBHOOK_SECRET || undefined,
    linqPhoneNumber: env.MASTERY_LINQ_PHONE_NUMBER?.trim() || "+16462077638",
    linqReplyMode: parseReplyMode(env.LINQ_REPLY_MODE),
    linqVoiceSendTranscript: parseBoolean(env.LINQ_VOICE_SEND_TRANSCRIPT, false, "LINQ_VOICE_SEND_TRANSCRIPT"),
    linqVoiceMaxCharacters: parsePositiveInteger(env.LINQ_VOICE_MAX_CHARACTERS, 600, "LINQ_VOICE_MAX_CHARACTERS"),
    openAiTextModel: env.OPENAI_TEXT_MODEL ?? "gpt-5-mini",
    elevenLabsApiKey: env.ELEVENLABS_API_KEY || undefined,
    elevenLabsEnableLogging: parseBoolean(env.ELEVENLABS_ENABLE_LOGGING, true, "ELEVENLABS_ENABLE_LOGGING"),
    elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID?.trim() || "S9EGwlCtMF7VXtENq79v",
    elevenLabsTtsModel: env.ELEVENLABS_TTS_MODEL?.trim() || "eleven_flash_v2_5", elevenLabsSttModel: env.ELEVENLABS_STT_MODEL?.trim() || "scribe_v2"
  };
}
