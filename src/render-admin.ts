import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";

const API = "https://api.render.com/v1";
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"}); res.end(JSON.stringify(value)); }
function auth(config: Config, req: IncomingMessage) { return Boolean(config.outboundApiKey && req.headers.authorization === `Bearer ${config.outboundApiKey}`); }
async function render(config: Config, path: string, init: RequestInit = {}) {
  if (!config.renderApiKey) throw new Error("RENDER_API_KEY is not configured");
  const response = await fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${config.renderApiKey}`, accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  let value: unknown = text; try { value = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(`Render API ${response.status}: ${typeof value === "string" ? value.slice(0,300) : JSON.stringify(value).slice(0,300)}`);
  return value;
}
export async function handleRenderAdmin(config: Config, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/admin/render/")) return false;
  if (!auth(config, req)) { json(res,401,{error:"Unauthorized"}); return true; }
  if (!config.renderServiceId) { json(res,503,{error:"Render service id is not configured"}); return true; }
  try {
    if (req.method === "GET" && url.pathname === "/api/admin/render/service") { json(res,200,await render(config,`/services/${config.renderServiceId}`)); return true; }
    if (req.method === "GET" && url.pathname === "/api/admin/render/deploys") { json(res,200,await render(config,`/services/${config.renderServiceId}/deploys?limit=10`)); return true; }
    if (req.method === "GET" && url.pathname === "/api/admin/render/env-status") {
      const env = await render(config,`/services/${config.renderServiceId}/env-vars`) as any[];
      const keys = Array.isArray(env) ? env.map((x:any)=>x.envVar?.key ?? x.key).filter(Boolean) : [];
      json(res,200,{serviceId:config.renderServiceId, required:{RENDER_API_KEY:keys.includes("RENDER_API_KEY"),DATABASE_URL:keys.includes("DATABASE_URL"),OPENAI_API_KEY:keys.includes("OPENAI_API_KEY"),LINQ_API_TOKEN:keys.includes("LINQ_API_TOKEN")}, keys}); return true;
    }
    if (req.method === "POST" && url.pathname === "/api/admin/render/deploy") { json(res,202,await render(config,`/services/${config.renderServiceId}/deploys`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})); return true; }
    json(res,404,{error:"Not found"}); return true;
  } catch (error) { console.error("Render admin failed:",error); json(res,502,{error:error instanceof Error?error.message:"Render admin failed"}); return true; }
}
