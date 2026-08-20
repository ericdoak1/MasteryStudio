import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { buildVoiceTwiml } from "../src/twiml.js";
import { parseLinqMessage } from "../src/linq.js";

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
      chat: { id: "chat_123" },
      parts: [{ type: "text", value: "Help me reset after a mistake" }]
    }
  }, {});
  assert.deepEqual(message, {
    chatId: "chat_123",
    messageId: "msg_123",
    text: "Help me reset after a mistake"
  });
});
