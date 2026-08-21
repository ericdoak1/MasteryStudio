export type Config = {
  port: number;
  publicBaseUrl: string;
  openAiApiKey: string;
  openAiModel: string;
  openAiVoice: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  outboundApiKey?: string;
  masteryProfileUrl?: string;
  masteryProfileToken?: string;
  linqApiToken?: string;
  linqWebhookSecret?: string;
  openAiTextModel: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = ["OPENAI_API_KEY", "PUBLIC_BASE_URL"] as const;
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required environment variable: ${key}`);
  }

  const base = env.PUBLIC_BASE_URL!.replace(/\/$/, "");
  if (!base.startsWith("https://")) {
    throw new Error("PUBLIC_BASE_URL must start with https://");
  }

  return {
    port: Number(env.PORT ?? 3000),
    publicBaseUrl: base,
    openAiApiKey: env.OPENAI_API_KEY!,
    openAiModel: env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1",
    openAiVoice: env.OPENAI_VOICE ?? "marin",
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || undefined,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || undefined,
    twilioFromNumber: env.TWILIO_FROM_NUMBER || undefined,
    outboundApiKey: env.OUTBOUND_API_KEY || undefined,
    masteryProfileUrl: env.MASTERY_PROFILE_URL || undefined,
    masteryProfileToken: env.MASTERY_PROFILE_TOKEN || undefined,
    linqApiToken: env.LINQ_API_TOKEN || undefined,
    linqWebhookSecret: env.LINQ_WEBHOOK_SECRET || undefined,
    openAiTextModel: env.OPENAI_TEXT_MODEL ?? "gpt-5-mini"
  };
}
