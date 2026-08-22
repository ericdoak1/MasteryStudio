import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import twilio from "twilio";
import { loadConfig, type Config } from "./config.js";
import { fetchMemberContext } from "./member-context.js";
import { promptWithContext } from "./mastery-prompt.js";
import { buildVoiceTwiml } from "./twiml.js";
import {
  CommandCenterInputError,
  parseLinqMessage,
  processLinqMessage,
  sendCommandCenterLinqMessage,
  verifyLinqSignature,
  type CommandCenterLinqRequest
} from "./linq.js";

type JsonObject = Record<string, any>;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) throw new RequestBodyTooLargeError("Request body exceeds 1 MB");
  return Buffer.concat(chunks).toString("utf8");
}

function sendBodyError(res: ServerResponse, error: unknown): void {
  if (error instanceof RequestBodyTooLargeError) {
    sendJson(res, 413, { error: error.message });
  } else {
    sendJson(res, 400, { error: "Invalid JSON" });
  }
}

function safeSend(socket: WebSocket, event: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

function validateTwilioWebhook(config: Config, req: IncomingMessage, params: URLSearchParams): boolean {
  if (!config.twilioAuthToken) return true;
  const signature = req.headers["x-twilio-signature"];
  if (typeof signature !== "string") return false;
  const values = Object.fromEntries(params.entries());
  return twilio.validateRequest(
    config.twilioAuthToken,
    signature,
    `${config.publicBaseUrl}${req.url ?? "/voice/incoming"}`,
    values
  );
}

export function createMasteryServer(config: Config) {
  const mediaWss = new WebSocketServer({ noServer: true });

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/health") {
      return sendJson(res, 200, { ok: true, service: "mastery-voice-agent" });
    }

    if (req.method === "POST" && path === "/voice/outbound") {
      if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioFromNumber || !config.outboundApiKey) {
        return sendJson(res, 503, { error: "Outbound calling is not configured" });
      }
      if (req.headers.authorization !== `Bearer ${config.outboundApiKey}`) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }
      let body: { to?: string; task?: string; agentPrompt?: string };
      try { body = JSON.parse(await readBody(req)); } catch (error) { return sendBodyError(res, error); }
      const to = body.to?.trim();
      const task = body.task?.trim();
      const agentPrompt = body.agentPrompt?.trim();
      if (!to || !task || !agentPrompt) return sendJson(res, 400, { error: "to, task, and agentPrompt are required" });
      try {
        const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
        const call = await client.calls.create({
          to,
          from: config.twilioFromNumber,
          twiml: buildVoiceTwiml(config.publicBaseUrl, {
            caller: to,
            direction: "outbound",
            task,
            agentPrompt
          })
        });
        return sendJson(res, 202, { callSid: call.sid, status: call.status });
      } catch (error) {
        console.error("Outbound call failed:", error);
        return sendJson(res, 502, { error: error instanceof Error ? error.message : "Outbound call failed" });
      }
    }

    if (req.method === "POST" && path === "/voice/incoming") {
      let rawBody: string;
      try { rawBody = await readBody(req); } catch (error) { return sendBodyError(res, error); }
      const params = new URLSearchParams(rawBody);
      if (!validateTwilioWebhook(config, req, params)) {
        return sendJson(res, 403, { error: "Invalid Twilio signature" });
      }
      const twiml = buildVoiceTwiml(config.publicBaseUrl, {
        caller: params.get("From") ?? "",
        called: params.get("To") ?? "",
        callSid: params.get("CallSid") ?? ""
      });
      res.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
      return res.end(twiml);
    }

    if (req.method === "POST" && path === "/linq/send") {
      if (!config.linqApiToken || !config.outboundApiKey) {
        return sendJson(res, 503, { error: "Command Center messaging is not configured" });
      }
      if (req.headers.authorization !== `Bearer ${config.outboundApiKey}`) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }
      let body: CommandCenterLinqRequest;
      try { body = JSON.parse(await readBody(req)); } catch (error) { return sendBodyError(res, error); }
      try {
        const result = await sendCommandCenterLinqMessage(config, body);
        return sendJson(res, 200, result);
      } catch (error) {
        if (error instanceof CommandCenterInputError) {
          return sendJson(res, 400, { error: error.message });
        }
        console.error("Command Center message failed:", error);
        return sendJson(res, 502, {
          error: error instanceof Error ? error.message : "Command Center message failed"
        });
      }
    }

    if (req.method === "POST" && path === "/linq/webhook") {
      if (!config.linqApiToken || !config.linqWebhookSecret) {
        return sendJson(res, 503, { error: "Linq webhook verification is not configured" });
      }
      let rawBody: string;
      try { rawBody = await readBody(req); } catch (error) { return sendBodyError(res, error); }
      if (!verifyLinqSignature(rawBody, req.headers, config.linqWebhookSecret)) {
        return sendJson(res, 401, { error: "Invalid Linq signature" });
      }
      let body: JsonObject;
      try { body = JSON.parse(rawBody); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }
      const message = parseLinqMessage(body, req.headers);
      sendJson(res, 200, { received: true });
      if (message) processLinqMessage(config, message).catch((error) => console.error("Linq message failed:", error));
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/voice/media") return socket.destroy();
    mediaWss.handleUpgrade(req, socket, head, (ws) => mediaWss.emit("connection", ws, req));
  });

  mediaWss.on("connection", (twilioWs) => {
    let streamSid = "";
    let caller = "";
    let openAiReady = false;
    const pendingOpenAiEvents: unknown[] = [];

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.openAiModel)}`,
      { headers: { Authorization: `Bearer ${config.openAiApiKey}` } }
    );

    const sendToOpenAi = (event: unknown): void => {
      if (openAiReady && openAiWs.readyState === WebSocket.OPEN) {
        safeSend(openAiWs, event);
      } else {
        pendingOpenAiEvents.push(event);
      }
    };

    openAiWs.on("open", () => {
      openAiReady = true;
      for (const event of pendingOpenAiEvents.splice(0)) {
        safeSend(openAiWs, event);
      }
    });

    twilioWs.on("message", async (raw) => {
      let event: JsonObject;
      try { event = JSON.parse(raw.toString()); } catch { return; }

      if (event.event === "start") {
        streamSid = event.start?.streamSid ?? event.streamSid ?? "";
        caller = event.start?.customParameters?.caller ?? "";
        const task = event.start?.customParameters?.task ?? "";
        const agentPrompt = event.start?.customParameters?.agentPrompt ?? "";
        const context = await fetchMemberContext(config, caller);
        sendToOpenAi({
          type: "session.update",
          session: {
            type: "realtime",
            model: config.openAiModel,
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcmu" },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                  create_response: true,
                  interrupt_response: true
                }
              },
              output: { format: { type: "audio/pcmu" }, voice: config.openAiVoice }
            },
            instructions: agentPrompt
              ? `${agentPrompt}\n\nYour assignment for this call:\n${task}`
              : promptWithContext(context)
          }
        });
        sendToOpenAi({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "The phone call just connected. Greet the caller now and begin." }]
          }
        });
        sendToOpenAi({ type: "response.create" });
      }

      if (event.event === "media" && typeof event.media?.payload === "string") {
        sendToOpenAi({ type: "input_audio_buffer.append", audio: event.media.payload });
      }

      if (event.event === "stop") openAiWs.close();
    });

    openAiWs.on("message", (raw) => {
      let event: JsonObject;
      try { event = JSON.parse(raw.toString()); } catch { return; }

      if (event.type === "response.output_audio.delta" && event.delta && streamSid) {
        safeSend(twilioWs, { event: "media", streamSid, media: { payload: event.delta } });
      }
      if (event.type === "input_audio_buffer.speech_started" && streamSid) {
        safeSend(twilioWs, { event: "clear", streamSid });
      }
      if (event.type === "error") console.error("OpenAI Realtime error:", event.error);
    });

    const closeBoth = () => {
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    };
    twilioWs.on("error", (error) => console.error("Twilio stream error:", error));
    openAiWs.on("error", (error) => console.error("OpenAI socket error:", error));
    twilioWs.on("close", closeBoth);
    openAiWs.on("close", (code, reason) => {
      console.info("Call bridge closed", { caller, streamSid, code, reason: reason.toString() });
      closeBoth();
    });
  });

  return server;
}

if (process.env.NODE_ENV !== "test") {
  const config = loadConfig();
  createMasteryServer(config).listen(config.port, "0.0.0.0", () => {
    console.info(`Mastery voice agent listening on port ${config.port}`);
  });
}
