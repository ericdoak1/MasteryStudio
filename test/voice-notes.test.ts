import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import {
  CommandCenterInputError,
  processLinqMessage,
  sendCommandCenterLinqMessage
} from "../src/linq.js";
import {
  AmbiguousVoiceDeliveryError,
  deliverLinqReply,
  sendLinqVoiceNoteBytes,
  synthesizeEmmaVoiceNote,
  transcribeLinqVoiceNote,
  type LinqVoiceClient
} from "../src/voice-notes.js";

function voiceConfig() {
  return loadConfig({
    OPENAI_API_KEY: "openai-key",
    PUBLIC_BASE_URL: "https://mastery.example.com",
    ELEVENLABS_API_KEY: "eleven-key",
    ELEVENLABS_VOICE_ID: "emma-voice",
    ELEVENLABS_TTS_MODEL: "eleven-model",
    ELEVENLABS_STT_MODEL: "scribe-model"
  });
}

function fakeClient(overrides: Partial<LinqVoiceClient> = {}) {
  const textMessages: string[] = [];
  const textIdempotencyKeys: Array<string | undefined> = [];
  const voiceMemos: Array<{ chatId: string; attachmentId: string; maxRetries?: number }> = [];
  const attachmentRequests: Array<{ content_type: string; filename: string; size_bytes: number }> = [];
  const deletedAttachments: string[] = [];
  const client: LinqVoiceClient = {
    attachments: {
      async create(body) {
        attachmentRequests.push(body);
        return {
          attachment_id: "attachment-123",
          http_method: "PUT",
          required_headers: { "content-type": "audio/mpeg", "x-test": "required" },
          upload_url: "https://uploads.example.com/voice.mp3"
        };
      },
      async delete(attachmentId) { deletedAttachments.push(attachmentId); }
    },
    chats: {
      messages: {
        async send(_chatId, body) {
          textMessages.push(body.message.parts[0].value);
          textIdempotencyKeys.push(body.message.idempotency_key);
        }
      },
      async sendVoicememo(chatId, body, options) {
        voiceMemos.push({ chatId, attachmentId: body.attachment_id, maxRetries: options?.maxRetries });
      }
    },
    ...overrides
  };
  return {
    client,
    textMessages,
    textIdempotencyKeys,
    voiceMemos,
    attachmentRequests,
    deletedAttachments
  };
}

function chatPage(chats: any[]) {
  return {
    getPaginatedItems: () => chats,
    async *[Symbol.asyncIterator]() {
      yield* chats;
    }
  };
}

function directChat(id = "existing-chat", to = "+15551234567") {
  return {
    id,
    is_group: false,
    updated_at: "2026-08-21T00:00:00.000Z",
    service: "iMessage",
    health_status: { status: "HEALTHY" },
    handles: [
      { handle: "+15550000000", is_me: true, status: "active" },
      { handle: to, is_me: false, status: "active" }
    ]
  };
}

test("synthesizeEmmaVoiceNote calls ElevenLabs with Emma's configured voice", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body));
    assert.equal(new Headers(init?.headers).get("xi-api-key"), "eleven-key");
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" }
    });
  }) as typeof fetch;

  const audio = await synthesizeEmmaVoiceNote(voiceConfig(), "A short note", fetchImplementation);
  assert.deepEqual([...audio], [1, 2, 3]);
  assert.match(requestedUrl, /\/text-to-speech\/emma-voice\?output_format=mp3_44100_128/);
  assert.match(requestedUrl, /enable_logging=true/);
  assert.deepEqual(requestedBody, { text: "A short note", model_id: "eleven-model" });
});

test("transcribeLinqVoiceNote sends a signed Linq URL to ElevenLabs Scribe", async () => {
  const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.match(String(input), /enable_logging=true/);
    assert.equal(new Headers(init?.headers).get("xi-api-key"), "eleven-key");
    const form = init?.body as FormData;
    assert.equal(form.get("model_id"), "scribe-model");
    assert.equal(form.get("source_url"), "https://cdn.linqapp.com/note.m4a");
    return Response.json({ text: "I want to understand my team better." });
  }) as typeof fetch;

  const transcript = await transcribeLinqVoiceNote(
    voiceConfig(),
    "https://cdn.linqapp.com/note.m4a",
    fetchImplementation
  );
  assert.equal(transcript, "I want to understand my team better.");
});

test("sendLinqVoiceNoteBytes pre-uploads exact bytes and sends a native voice memo", async () => {
  const { client, voiceMemos, attachmentRequests } = fakeClient();
  let uploadedBody: Uint8Array | undefined;
  const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(String(input), "https://uploads.example.com/voice.mp3");
    assert.equal(init?.method, "PUT");
    assert.equal(new Headers(init?.headers).get("x-test"), "required");
    uploadedBody = new Uint8Array(init?.body as ArrayBuffer);
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  await sendLinqVoiceNoteBytes(client, "chat-123", new Uint8Array([4, 5, 6]), fetchImplementation);
  assert.equal(attachmentRequests.length, 1);
  assert.equal(attachmentRequests[0].content_type, "audio/mpeg");
  assert.equal(attachmentRequests[0].size_bytes, 3);
  assert.match(attachmentRequests[0].filename, /^emma-.+\.mp3$/);
  assert.deepEqual([...(uploadedBody ?? [])], [4, 5, 6]);
  assert.deepEqual(voiceMemos, [{
    chatId: "chat-123",
    attachmentId: "attachment-123",
    maxRetries: 0
  }]);
});

test("sendLinqVoiceNoteBytes cleans up an attachment after an upload network failure", async () => {
  const { client, deletedAttachments, voiceMemos } = fakeClient();
  const fetchImplementation = (async () => {
    throw new TypeError("connection reset");
  }) as typeof fetch;

  await assert.rejects(
    sendLinqVoiceNoteBytes(client, "chat-123", new Uint8Array([1]), fetchImplementation),
    /connection reset/
  );
  assert.deepEqual(deletedAttachments, ["attachment-123"]);
  assert.equal(voiceMemos.length, 0);
});

test("deliverLinqReply falls back to the same text when synthesis is rejected", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const { client, textMessages, textIdempotencyKeys, voiceMemos } = fakeClient();
  const fetchImplementation = (async () => new Response("denied", { status: 401 })) as typeof fetch;
  const result = await deliverLinqReply(
    voiceConfig(),
    client,
    "chat-123",
    "The exact Emma reply",
    "voice",
    { fetchImplementation, idempotencyKey: "fallback-key" }
  );
  assert.deepEqual(result, { delivery: "text", fellBackToText: true });
  assert.deepEqual(textMessages, ["The exact Emma reply"]);
  assert.deepEqual(textIdempotencyKeys, ["fallback-key"]);
  assert.equal(voiceMemos.length, 0);
});

test("deliverLinqReply does not send duplicate text after an ambiguous voice send", async () => {
  const base = fakeClient();
  base.client.chats.sendVoicememo = async () => { throw new Error("socket closed"); };
  let call = 0;
  const fetchImplementation = (async () => {
    call += 1;
    if (call === 1) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" }
      });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  await assert.rejects(
    deliverLinqReply(voiceConfig(), base.client, "chat-123", "One message", "voice", { fetchImplementation }),
    AmbiguousVoiceDeliveryError
  );
  assert.deepEqual(base.textMessages, []);
});

test("Command Center reuses an existing chat without repeating Emma's introduction", async () => {
  const base = fakeClient();
  let openers = 0;
  const client = {
    ...base.client,
    chats: {
      ...base.client.chats,
      listChats() {
        return chatPage([directChat()]);
      },
      async retrieve() { return directChat(); },
      async markAsRead() {},
      typing: { async start() {}, async stop() {} }
    },
    messages: {
      async create() {
        openers += 1;
        return { chat_id: "new-chat" };
      }
    }
  };
  let call = 0;
  const fetchImplementation = (async () => {
    call += 1;
    return call === 1
      ? new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } })
      : new Response(null, { status: 200 });
  }) as typeof fetch;

  const result = await sendCommandCenterLinqMessage(voiceConfig(), {
    to: "+15551234567",
    text: "A personal follow-up",
    delivery: "voice",
    idempotencyKey: "existing-chat-voice"
  }, { client: client as any, fetchImplementation });
  assert.equal(openers, 0);
  assert.equal(result.chatId, "existing-chat");
  assert.equal(result.openedConversation, false);
});

test("Command Center opens a new voice conversation with one identification text", async () => {
  const base = fakeClient();
  const openers: string[] = [];
  const client = {
    ...base.client,
    chats: {
      ...base.client.chats,
      listChats() {
        return chatPage([]);
      },
      async retrieve() { return directChat("new-chat"); },
      async markAsRead() {},
      typing: { async start() {}, async stop() {} }
    },
    messages: {
      async create(body: { message: { parts: Array<{ value: string }> } }) {
        openers.push(body.message.parts[0].value);
        return {
          chat_id: "new-chat",
          created_new_chat: true,
          from: "+15550000000",
          handles: directChat("new-chat").handles,
          is_group: false,
          service: "iMessage"
        };
      }
    }
  };
  let call = 0;
  const fetchImplementation = (async () => {
    call += 1;
    return call === 1
      ? new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } })
      : new Response(null, { status: 200 });
  }) as typeof fetch;

  const result = await sendCommandCenterLinqMessage(voiceConfig(), {
    to: "+15551234567",
    text: "I would love to get to know how you coach.",
    delivery: "voice",
    idempotencyKey: "new-chat-voice"
  }, { client: client as any, fetchImplementation });
  assert.deepEqual(openers, ["Hi, it's Emma from Mastery."]);
  assert.equal(result.chatId, "new-chat");
  assert.equal(result.openedConversation, true);
});

test("Command Center never resolves a phone recipient to a group chat", async () => {
  const base = fakeClient();
  const groupChat = {
    ...directChat("group-chat"),
    is_group: true,
    handles: [
      ...directChat("group-chat").handles,
      { handle: "+15557654321", is_me: false, status: "active" }
    ]
  };
  const openers: string[] = [];
  const client = {
    ...base.client,
    chats: {
      ...base.client.chats,
      listChats: () => chatPage([groupChat]),
      async retrieve() { return directChat("safe-direct"); },
      async markAsRead() {},
      typing: { async start() {}, async stop() {} }
    },
    messages: {
      async create(body: { message: { parts: Array<{ value: string }> } }) {
        openers.push(body.message.parts[0].value);
        return {
          chat_id: "safe-direct",
          created_new_chat: true,
          from: "+15550000000",
          handles: directChat("safe-direct").handles,
          is_group: false,
          service: "iMessage"
        };
      }
    }
  };
  let fetchCall = 0;
  const fetchImplementation = (async () => {
    fetchCall += 1;
    return fetchCall === 1
      ? new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } })
      : new Response(null, { status: 200 });
  }) as typeof fetch;

  const result = await sendCommandCenterLinqMessage(voiceConfig(), {
    to: "+15551234567",
    text: "This belongs only in the direct Emma thread.",
    delivery: "voice",
    idempotencyKey: "group-safety"
  }, { client: client as any, fetchImplementation });

  assert.deepEqual(openers, ["Hi, it's Emma from Mastery."]);
  assert.equal(result.chatId, "safe-direct");
  assert.equal(base.voiceMemos[0].chatId, "safe-direct");
});

test("Command Center rejects ambiguous direct-chat matches", async () => {
  const base = fakeClient();
  const client = {
    ...base.client,
    chats: {
      ...base.client.chats,
      listChats: () => chatPage([directChat("chat-one"), directChat("chat-two")]),
      async retrieve() { return directChat(); },
      async markAsRead() {},
      typing: { async start() {}, async stop() {} }
    },
    messages: { async create() { throw new Error("must not open a chat"); } }
  };

  await assert.rejects(sendCommandCenterLinqMessage(voiceConfig(), {
    to: "+15551234567",
    text: "A private note",
    delivery: "voice",
    idempotencyKey: "ambiguous-chat"
  }, { client: client as any }), /Multiple direct Linq chats/);
  assert.equal(base.voiceMemos.length, 0);
});

test("Command Center rejects voice delivery to a group chatId", async () => {
  const base = fakeClient();
  const client = {
    ...base.client,
    chats: {
      ...base.client.chats,
      listChats: () => chatPage([]),
      async retrieve() {
        return { ...directChat("group-chat"), is_group: true };
      },
      async markAsRead() {},
      typing: { async start() {}, async stop() {} }
    },
    messages: { async create() { throw new Error("must not open a chat"); } }
  };

  await assert.rejects(sendCommandCenterLinqMessage(voiceConfig(), {
    chatId: "group-chat",
    text: "A private note",
    delivery: "voice",
    idempotencyKey: "group-chat-id"
  }, { client: client as any }), CommandCenterInputError);
  assert.equal(base.voiceMemos.length, 0);
});

test("Command Center reports when a text send reused an existing chat", async () => {
  const base = fakeClient();
  const requests: any[] = [];
  const client = {
    ...base.client,
    messages: {
      async create(body: any) {
        requests.push(body);
        return {
          chat_id: "reused-chat",
          created_new_chat: false,
          from: "+15550000000",
          handles: directChat("reused-chat").handles,
          is_group: false,
          service: "iMessage"
        };
      }
    }
  };

  const result = await sendCommandCenterLinqMessage(voiceConfig(), {
    to: "+15551234567",
    text: "Quick logistics update",
    delivery: "text",
    idempotencyKey: "reused-text-chat"
  }, { client: client as any });

  assert.equal(result.openedConversation, false);
  assert.match(requests[0]["Idempotency-Key"], /^emma-text-[a-f0-9]{64}$/);
});

test("Command Center reports an explicit voice downgrade when ElevenLabs is unavailable", async () => {
  const base = fakeClient();
  const client = {
    ...base.client,
    messages: {
      async create() {
        return {
          chat_id: "text-fallback-chat",
          created_new_chat: false,
          from: "+15550000000",
          handles: directChat("text-fallback-chat").handles,
          is_group: false,
          service: "iMessage"
        };
      }
    }
  };
  const config = loadConfig({
    OPENAI_API_KEY: "openai-key",
    PUBLIC_BASE_URL: "https://mastery.example.com"
  });

  const result = await sendCommandCenterLinqMessage(config, {
    to: "+15551234567",
    text: "Voice was requested.",
    delivery: "voice",
    idempotencyKey: "explicit-voice-downgrade"
  }, { client: client as any });

  assert.equal(result.delivery, "text");
  assert.equal(result.fellBackToText, true);
  assert.equal(result.nativeVoiceBubble, false);
});

test("Command Center deduplicates a repeated native voice operation", async () => {
  const base = fakeClient();
  let resolutions = 0;
  const client = {
    ...base.client,
    chats: {
      ...base.client.chats,
      listChats: () => {
        resolutions += 1;
        return chatPage([directChat()]);
      },
      async retrieve() { return directChat(); },
      async markAsRead() {},
      typing: { async start() {}, async stop() {} }
    },
    messages: { async create() { throw new Error("must not open a chat"); } }
  };
  let fetchCall = 0;
  const fetchImplementation = (async () => {
    fetchCall += 1;
    return fetchCall === 1
      ? new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } })
      : new Response(null, { status: 200 });
  }) as typeof fetch;
  const request = {
    to: "+15551234567",
    text: "One operation, one voice memo.",
    delivery: "voice" as const,
    idempotencyKey: "dedupe-native-voice"
  };

  const [first, second] = await Promise.all([
    sendCommandCenterLinqMessage(voiceConfig(), request, { client: client as any, fetchImplementation }),
    sendCommandCenterLinqMessage(voiceConfig(), request, { client: client as any, fetchImplementation })
  ]);

  assert.deepEqual(first, second);
  assert.equal(resolutions, 1);
  assert.equal(base.voiceMemos.length, 1);
});

test("inbound group messages are ignored by the one-to-one Emma agent", async () => {
  const base = fakeClient();
  const client = {
    ...base.client,
    chats: {
      ...base.client.chats,
      listChats: () => chatPage([]),
      async retrieve() { throw new Error("current webhook already identified the group"); },
      async markAsRead() {},
      typing: { async start() {}, async stop() {} }
    },
    messages: { async create() { throw new Error("not used"); } }
  };
  let fetchCalls = 0;
  const fetchImplementation = (async () => {
    fetchCalls += 1;
    return Response.json({ output_text: "[voice] That is worth sitting with for a minute." });
  }) as typeof fetch;
  const config = loadConfig({
    OPENAI_API_KEY: "openai-key",
    PUBLIC_BASE_URL: "https://mastery.example.com",
    ELEVENLABS_API_KEY: "eleven-key",
    LINQ_REPLY_MODE: "auto"
  });

  await processLinqMessage(config, {
    chatId: "group-chat",
    messageId: "group-inbound-unique",
    text: "We had a rough practice.",
    senderHandle: "+15551234567",
    isGroup: true
  }, { client: client as any, fetchImplementation });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(base.textMessages, []);
  assert.equal(base.voiceMemos.length, 0);
});

test("inbound direct messages load member context into Emma's prompt", async () => {
  const base = fakeClient();
  const client = {
    ...base.client,
    chats: {
      ...base.client.chats,
      listChats: () => chatPage([]),
      async retrieve() { return directChat("direct-context"); },
      async markAsRead() {},
      typing: { async start() {}, async stop() {} }
    },
    messages: { async create() { throw new Error("not used"); } }
  };
  const seenUrls: string[] = [];
  let openAiInstructions = "";
  const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
    seenUrls.push(String(input));
    if (String(input).startsWith("https://profiles.example.com/member")) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer profile-token");
      assert.match(String(input), /phone=%2B15551234567/);
      return Response.json({
        organization: "North Star",
        role: "coach",
        apiToken: "must-not-leak",
        nested: { password: "also-must-not-leak", focus: "composure" }
      });
    }
    const body = JSON.parse(String(init?.body));
    openAiInstructions = body.instructions;
    return Response.json({ output_text: "[text] Good to hear from you. What feels most important today?" });
  }) as typeof fetch;
  const config = loadConfig({
    OPENAI_API_KEY: "openai-key",
    PUBLIC_BASE_URL: "https://mastery.example.com",
    MASTERY_PROFILE_URL: "https://profiles.example.com/member",
    MASTERY_PROFILE_TOKEN: "profile-token",
    LINQ_REPLY_MODE: "auto"
  });

  await processLinqMessage(config, {
    chatId: "direct-context",
    messageId: "direct-context-inbound-unique",
    text: "Checking back in.",
    senderHandle: "+15551234567",
    isGroup: false
  }, { client: client as any, fetchImplementation });

  assert.equal(seenUrls.length, 2);
  assert.match(openAiInstructions, /North Star/);
  assert.match(openAiInstructions, /composure/);
  assert.doesNotMatch(openAiInstructions, /must-not-leak/);
  assert.match(openAiInstructions, /Continue the relationship/);
  assert.deepEqual(base.textMessages, ["Good to hear from you. What feels most important today?"]);
});

test("Command Center rejects non-object request bodies", async () => {
  await assert.rejects(
    sendCommandCenterLinqMessage(voiceConfig(), null as any),
    CommandCenterInputError
  );
});

test("Command Center rejects every invalid delivery and purpose value", async () => {
  const invalidValues: unknown[] = ["", false, 0, [], {}];
  for (const [index, value] of invalidValues.entries()) {
    await assert.rejects(sendCommandCenterLinqMessage(voiceConfig(), {
      to: "+15551234567",
      text: "Do not send",
      delivery: value,
      idempotencyKey: `invalid-delivery-${index}`
    } as any), CommandCenterInputError);
    await assert.rejects(sendCommandCenterLinqMessage(voiceConfig(), {
      to: "+15551234567",
      text: "Do not send",
      purpose: value,
      idempotencyKey: `invalid-purpose-${index}`
    } as any), CommandCenterInputError);
  }
});
