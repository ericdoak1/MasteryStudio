import type { Config } from "./config.js";
import { upsertStudioProfile } from "./studio-store.js";

export type EmmaStudioAction = { field: "vision"|"mission"|"weeklyTheme"; value: string };

export async function detectStudioAction(config: Config, text: string, context: Record<string, unknown>, fetchImplementation: typeof fetch = fetch): Promise<EmmaStudioAction | null> {
  if (!config.databaseUrl) return null;
  const response = await fetchImplementation("https://api.openai.com/v1/responses", { method:"POST", headers:{authorization:`Bearer ${config.openAiApiKey}`,"content-type":"application/json"}, body:JSON.stringify({model:config.openAiTextModel,store:false,instructions:"Detect only explicit user requests to change their Mastery Studio vision, mission, or weekly theme. Return exactly NONE when there is no explicit update request. Otherwise return one line FIELD|VALUE where FIELD is vision, mission, or weeklyTheme. Never infer a change from discussion or questions.",input:`Current Studio context: ${JSON.stringify(context)}\n\nUser message: ${text}`}), signal:AbortSignal.timeout(15000)});
  if(!response.ok)return null; const result=await response.json() as any; const raw=String(result.output_text??"").trim(); if(raw==="NONE")return null;
  const match=raw.match(/^(vision|mission|weeklyTheme)\|(.+)$/s); if(!match)return null; return {field:match[1] as EmmaStudioAction["field"],value:match[2].trim()};
}

export async function applyStudioAction(config: Config, phone: string, action: EmmaStudioAction) {
  return upsertStudioProfile(config, phone, { [action.field]: action.value });
}
