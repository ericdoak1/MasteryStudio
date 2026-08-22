import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";

const API = "https://api.render.com/v1";
const DATABASE_NAME = "mastery-studio-db";
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"}); res.end(JSON.stringify(value)); }
function auth(config: Config, req: IncomingMessage) { return Boolean(config.outboundApiKey && req.headers.authorization === `Bearer ${config.outboundApiKey}`); }
async function requestWithKey(apiKey:string,path:string,init:RequestInit={}){const response=await fetch(`${API}${path}`,{...init,headers:{authorization:`Bearer ${apiKey}`,accept:"application/json",...(init.body?{"content-type":"application/json"}:{}),...(init.headers??{})},signal:AbortSignal.timeout(15000)});const text=await response.text();let value:any=text;try{value=text?JSON.parse(text):{};}catch{}if(!response.ok)throw new Error(`Render API ${response.status}: ${typeof value==="string"?value.slice(0,300):JSON.stringify(value).slice(0,300)}`);return value;}
async function render(config: Config, path: string, init: RequestInit = {}) {if(!config.renderApiKey)throw new Error("RENDER_API_KEY is not configured");return requestWithKey(config.renderApiKey,path,init);}
function unwrapPostgresList(value:any):any[]{if(!Array.isArray(value))return[];return value.map(item=>item?.postgres??item).filter(Boolean);}
function sleep(ms:number){return new Promise(resolve=>setTimeout(resolve,ms));}

async function selfHealDatabaseFromEnvironment(){
 const apiKey=process.env.RENDER_API_KEY?.trim(),serviceId=(process.env.RENDER_SERVICE_ID||"srv-da3o9l8u01pc73c2ggvg").trim();
 if(process.env.NODE_ENV==="test"||process.env.DATABASE_URL||!apiKey||!serviceId)return;
 console.warn("DATABASE_URL missing; attempting guarded Render Postgres self-heal");
 const service=await requestWithKey(apiKey,`/services/${encodeURIComponent(serviceId)}`);
 const ownerId=String(service?.ownerId??service?.owner_id??service?.owner?.id??"");
 const region=String(service?.serviceDetails?.region??service?.region??"oregon");
 if(!ownerId)throw new Error("Could not resolve Render workspace owner for database bootstrap");
 const listed=unwrapPostgresList(await requestWithKey(apiKey,`/postgres?name=${encodeURIComponent(DATABASE_NAME)}&limit=20`));
 let database=listed.find(item=>item?.name===DATABASE_NAME);
 if(!database){
  console.info("No Mastery Studio Postgres found; creating one");
  const created=await requestWithKey(apiKey,"/postgres",{method:"POST",body:JSON.stringify({name:DATABASE_NAME,ownerId,plan:"basic-256mb",region,version:"18",connectionPool:"none",enableHighAvailability:false})});
  database=created?.postgres??created;
 }
 const postgresId=String(database?.id??"");
 if(!postgresId)throw new Error("Render Postgres bootstrap did not return a database id");
 let connectionInfo:any=null;
 for(let attempt=0;attempt<24;attempt++){
  try{connectionInfo=await requestWithKey(apiKey,`/postgres/${encodeURIComponent(postgresId)}/connection-info`);if(connectionInfo?.internalConnectionString)break;}catch(error){if(attempt===23)throw error;}
  await sleep(10000);
 }
 const databaseUrl=String(connectionInfo?.internalConnectionString??"");
 if(!databaseUrl)throw new Error("Render Postgres never returned an internal connection string");
 await requestWithKey(apiKey,`/services/${encodeURIComponent(serviceId)}/env-vars/DATABASE_URL`,{method:"PUT",body:JSON.stringify({value:databaseUrl})});
 console.info("DATABASE_URL attached to Mastery service; triggering clean redeploy");
 await requestWithKey(apiKey,`/services/${encodeURIComponent(serviceId)}/deploys`,{method:"POST",body:"{}"});
}

if(process.env.NODE_ENV!=="test")setTimeout(()=>{selfHealDatabaseFromEnvironment().catch(error=>console.error("Render database self-heal failed:",error));},3000);

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
    if (req.method === "POST" && url.pathname === "/api/admin/render/deploy") { json(res,202,await render(config,`/services/${config.renderServiceId}/deploys`,{method:"POST",body:"{}"})); return true; }
    json(res,404,{error:"Not found"}); return true;
  } catch (error) { console.error("Render admin failed:",error); json(res,502,{error:error instanceof Error?error.message:"Render admin failed"}); return true; }
}
