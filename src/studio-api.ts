import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";
import { getStudioProfile, studioContextForPhone, upsertStudioProfile, type StudioProfile } from "./studio-store.js";

const MAX_BODY = 256 * 1024;

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function authorized(config: Config, req: IncomingMessage): boolean {
  const expected = config.masteryStudioContextToken ?? config.outboundApiKey;
  return Boolean(expected && req.headers.authorization === `Bearer ${expected}`);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.byteLength;
    if (size > MAX_BODY) throw new Error("Body too large");
    chunks.push(b);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JSON object");
  return parsed as Record<string, unknown>;
}

function validPhone(value: unknown): value is string {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value);
}

export async function handleStudioApi(
  config: Config,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/studio/") && path !== "/api/emma/context") return false;

  if (!config.databaseUrl) {
    json(res, 503, { error: "Studio database is not configured" });
    return true;
  }
  if (!authorized(config, req)) {
    json(res, 401, { error: "Unauthorized" });
    return true;
  }

  if (req.method === "GET" && path === "/api/emma/context") {
    const phone = url.searchParams.get("phone");
    if (!validPhone(phone)) {
      json(res, 400, { error: "Valid E.164 phone is required" });
      return true;
    }
    json(res, 200, await studioContextForPhone(config, phone));
    return true;
  }

  if (req.method === "GET" && path === "/api/studio/profile") {
    const phone = url.searchParams.get("phone");
    if (!validPhone(phone)) {
      json(res, 400, { error: "Valid E.164 phone is required" });
      return true;
    }
    const profile = await getStudioProfile(config, phone);
    json(res, profile ? 200 : 404, profile ?? { error: "Profile not found" });
    return true;
  }

  if ((req.method === "PUT" || req.method === "PATCH") && path === "/api/studio/profile") {
    try {
      const payload = await body(req);
      const phone = payload.phone;
      if (!validPhone(phone)) {
        json(res, 400, { error: "Valid E.164 phone is required" });
        return true;
      }
      const patch: Partial<Omit<StudioProfile, "phone" | "updatedAt">> = {};
      if (typeof payload.name === "string" || payload.name === null) patch.name = payload.name as string | null;
      if (typeof payload.organization === "string" || payload.organization === null) patch.organization = payload.organization as string | null;
      if (typeof payload.vision === "string" || payload.vision === null) patch.vision = payload.vision as string | null;
      if (typeof payload.mission === "string" || payload.mission === null) patch.mission = payload.mission as string | null;
      if (typeof payload.weeklyTheme === "string" || payload.weeklyTheme === null) patch.weeklyTheme = payload.weeklyTheme as string | null;
      if (Object.prototype.hasOwnProperty.call(payload, "goals")) patch.goals = payload.goals;
      if (Object.prototype.hasOwnProperty.call(payload, "knowledge")) patch.knowledge = payload.knowledge;
      const profile = await upsertStudioProfile(config, phone, patch);
      json(res, 200, profile);
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    }
    return true;
  }

  json(res, 404, { error: "Not found" });
  return true;
}
