import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { fetchMemberContext } from "../src/member-context.js";
import { buildVoiceTwiml } from "../src/twiml.js";
import {
  isLinqOptOut,
  parseLinqMessage,
  parseReplyPlan,
  resolveDeliveryMode,
  verifyLinqSignature
} from "../src/linq.js";

test("buildVoiceTwiml creates a bidirectional secure stream and escapes fields", () => {
  const xml = buildVoiceTwiml("https://mastery.example.com", {
    caller: "+1555&123",
    callSid: 'CA"abc'
  });
  assert.match(xml, /wss:\/\/mastery\.example\.com\/voice\/media/);
  assert.match(xml, /\+1555&amp;123/);
  assert.match(xml, /CA&quot;abc/);
});

test("loadConfig requires HTTPS and supplies current defaults", () => {
  const config = loadConfig({
    OPENAI_API_KEY: "test-key",
    PUBLIC_BASE_URL: "https://mastery.example.com/"
  });
  assert.equal(config.publicBaseUrl, "https://mastery.example.com");
  assert.equal(config.openAiModel, "gpt-realtime-2.1");
  assert.equal(config.openAiVoice, "marin");
  assert.equal(config.linqReplyMode, "text");
  assert.equal(config.elevenLabsEnableLogging, true);
  assert.equal(config.elevenLabsVoiceId, "S9EGwlCtMF7VXtENq79v");
});

test("loadConfig rejects non-HTTPS public URLs", () => {
  assert.throws(() => loadConfig({
    OPENAI_API_KEY: "test-key",
    PUBLIC_BASE_URL: "http://localhost:3000"
  }), /https/);
});

test("parseLinqMessage reads current message.received webhooks", () => {
  const message = parseLinqMessage({
    event_type: "message.received",
    data: {
      id: "msg_123",
      direction: "inbound",
      chat: { id: "chat_123", is_group: false },
      sender_handle: { handle: "+15551234567" },
      service: "iMessage",
      parts: [{ type: "text", value: "Help me reset after a mistake" }]
    }
  }, {});
  assert.deepEqual(message, {
    chatId: "chat_123",
    messageId: "msg_123",
    text: "Help me reset after a mistake",
    senderHandle: "+15551234567",
    isGroup: false,
    service: "iMessage"
  });
});

test("parseLinqMessage accepts an inbound audio-only message", () => {
  const message = parseLinqMessage({
    event_type: "message.received",
    data: {
      id: "msg_audio",
      direction: "inbound",
      chat: { id: "chat_123" },
      parts: [{
        type: "media",
        filename: "note.m4a",
        mime_type: "audio/x-m4a",
        url: "https://cdn.linqapp.com/note.m4a"
      }]
    }
  }, {});
  assert.deepEqual(message, {
    chatId: "chat_123",
    messageId: "msg_audio",
    text: "",
    audio: {
      filename: "note.m4a",
      mimeType: "audio/x-m4a",
      url: "https://cdn.linqapp.com/note.m4a"
    }
  });
});

test("parseReplyPlan removes the hidden delivery tag", () => {
  assert.deepEqual(parseReplyPlan("[voice] There is something important in that."), {
    text: "There is something important in that.",
    recommendedDelivery: "voice"
  });
});

test("resolveDeliveryMode falls back to text when voice is unavailable or too long", () => {
  const withoutVoice = loadConfig({
    OPENAI_API_KEY: "test-key",
    PUBLIC_BASE_URL: "https://mastery.example.com",
    LINQ_REPLY_MODE: "auto"
  });
  assert.equal(resolveDeliveryMode(withoutVoice, "auto", "voice", "Short reply"), "text");

  const withVoice = loadConfig({
    OPENAI_API_KEY: "test-key",
    PUBLIC_BASE_URL: "https://mastery.example.com",
    ELEVENLABS_API_KEY: "eleven-key",
    LINQ_VOICE_MAX_CHARACTERS: "5"
  });
  assert.equal(resolveDeliveryMode(withVoice, "voice", "text", "Too long"), "text");
});

test("loadConfig rejects an invalid Linq reply mode", () => {
  assert.throws(() => loadConfig({
    OPENAI_API_KEY: "test-key",
    PUBLIC_BASE_URL: "https://mastery.example.com",
    LINQ_REPLY_MODE: "sometimes"
  }), /text, voice, or auto/);
});

test("isLinqOptOut recognizes exact unsubscribe commands", () => {
  assert.equal(isLinqOptOut(" stop "), true);
  assert.equal(isLinqOptOut("OPT-OUT"), true);
  assert.equal(isLinqOptOut("please stop sending these"), false);
});

test("verifyLinqSignature fails closed and accepts a valid signed webhook", () => {
  const rawBody = '{"event_type":"message.received"}';
  const id = "webhook-123";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawSecret = Buffer.from("test-signing-key");
  const secret = `whsec_${rawSecret.toString("base64")}`;
  const signature = createHmac("sha256", rawSecret)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");

  assert.equal(verifyLinqSignature(rawBody, {}, undefined), false);
  assert.equal(verifyLinqSignature(rawBody, {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`
  }, secret), true);
});

test("fetchMemberContext refuses a non-HTTPS profile endpoint", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const config = loadConfig({
    OPENAI_API_KEY: "test-key",
    PUBLIC_BASE_URL: "https://mastery.example.com",
    MASTERY_PROFILE_URL: "http://profiles.example.com/member"
  });
  let requested = false;
  const fetchImplementation = (async () => {
    requested = true;
    return Response.json({});
  }) as typeof fetch;

  assert.deepEqual(
    await fetchMemberContext(config, "+15551234567", fetchImplementation),
    {}
  );
  assert.equal(requested, false);
});

test("fetchMemberContext prefers full Studio context and requests all permission-scoped data", async () => {
  const config = loadConfig({
    OPENAI_API_KEY: "test-key",
    PUBLIC_BASE_URL: "https://mastery.example.com",
    MASTERY_PROFILE_URL: "https://profiles.example.com/member",
    MASTERY_STUDIO_CONTEXT_URL: "https://studio.example.com/api/emma/context",
    MASTERY_STUDIO_CONTEXT_TOKEN: "studio-token"
  });

  let requestedUrl = "";
  let authorization = "";
  const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    return Response.json({
      member: { name: "Eric" },
      studio: { weeklyTheme: "Keep the Main Thing the Main Thing" },
      api_key: "must-not-reach-model"
    });
  }) as typeof fetch;

  const context = await fetchMemberContext(config, "+15551234567", fetchImplementation);
  const url = new URL(requestedUrl);
  assert.equal(url.hostname, "studio.example.com");
  assert.equal(url.searchParams.get("phone"), "+15551234567");
  assert.equal(url.searchParams.get("scope"), "studio");
  assert.equal(url.searchParams.get("include"), "all");
  assert.equal(authorization, "Bearer studio-token");
  assert.equal((context.studio as Record<string, unknown>).weeklyTheme, "Keep the Main Thing the Main Thing");
  assert.equal("api_key" in context, false);
});
