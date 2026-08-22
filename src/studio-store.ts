import { Pool } from "pg";
import type { Config } from "./config.js";

export const DEFAULT_MASTERY_VISION = "Mastery helps leaders turn who they are and what they believe into a clear, repeatable way of developing people, building strong teams, and improving performance.";

export type StudioState = {
  organization: string;
  vision?: string | null;
  mission?: string | null;
  weeklyTheme?: string | null;
  knowledge?: unknown;
  updatedAt?: string | null;
};

export type StudioProfile = {
  phone: string;
  name?: string | null;
  organization?: string | null;
  vision?: string | null;
  mission?: string | null;
  weeklyTheme?: string | null;
  goals?: unknown;
  knowledge?: unknown;
  updatedAt?: string | null;
};

let pool: Pool | undefined;
let initialized = false;
function getPool(config: Config): Pool | undefined { if (!config.databaseUrl) return undefined; if (!pool) pool = new Pool({ connectionString: config.databaseUrl, max: 10 }); return pool; }
function date(value:any){return value?.toISOString?.() ?? String(value ?? "");}

export async function initializeStudioStore(config: Config): Promise<void> {
  const db=getPool(config); if(!db||initialized)return;
  await db.query(`
    create table if not exists studio_profiles (
      phone text primary key, name text, organization text, vision text, mission text, weekly_theme text,
      goals jsonb not null default '[]'::jsonb, knowledge jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create index if not exists studio_profiles_updated_at_idx on studio_profiles(updated_at desc);
    create table if not exists studio_state (
      id text primary key, organization text not null default 'Mastery', vision text, mission text, weekly_theme text,
      knowledge jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
    );
    insert into studio_state(id,organization,vision) values('mastery','Mastery',$$${DEFAULT_MASTERY_VISION}$$)
    on conflict(id) do nothing;
  `);
  // Migrate the freshest legacy profile-level values into shared Studio state once.
  await db.query(`
    update studio_state s set
      vision = coalesce((select p.vision from studio_profiles p where p.vision is not null and btrim(p.vision)<>'' order by p.updated_at desc limit 1), s.vision, $1),
      mission = coalesce(s.mission,(select p.mission from studio_profiles p where p.mission is not null and btrim(p.mission)<>'' order by p.updated_at desc limit 1)),
      weekly_theme = coalesce(s.weekly_theme,(select p.weekly_theme from studio_profiles p where p.weekly_theme is not null and btrim(p.weekly_theme)<>'' order by p.updated_at desc limit 1)),
      updated_at = now()
    where id='mastery'
  `,[DEFAULT_MASTERY_VISION]);
  initialized=true;
}

export async function getStudioState(config:Config):Promise<StudioState|null>{const db=getPool(config);if(!db)return null;await initializeStudioStore(config);const r=await db.query(`select organization,vision,mission,weekly_theme,knowledge,updated_at from studio_state where id='mastery' limit 1`);const x=r.rows[0];if(!x)return null;return{organization:x.organization,vision:x.vision,mission:x.mission,weeklyTheme:x.weekly_theme,knowledge:x.knowledge,updatedAt:date(x.updated_at)};}

export async function updateStudioState(config:Config,patch:Partial<Omit<StudioState,"updatedAt">>):Promise<StudioState>{const db=getPool(config);if(!db)throw new Error("DATABASE_URL is not configured");await initializeStudioStore(config);const current=await getStudioState(config)??{organization:"Mastery",vision:DEFAULT_MASTERY_VISION,knowledge:[]};const next={...current,...patch};await db.query(`update studio_state set organization=$1,vision=$2,mission=$3,weekly_theme=$4,knowledge=$5::jsonb,updated_at=now() where id='mastery'`,[next.organization??"Mastery",next.vision??null,next.mission??null,next.weeklyTheme??null,JSON.stringify(next.knowledge??[])]);return (await getStudioState(config))!;}

export async function getStudioProfile(config: Config, phone: string): Promise<StudioProfile | null> {const db=getPool(config);if(!db)return null;await initializeStudioStore(config);const r=await db.query(`select phone,name,organization,vision,mission,weekly_theme,goals,knowledge,updated_at from studio_profiles where phone=$1 limit 1`,[phone]);const x=r.rows[0];if(!x)return null;return{phone:x.phone,name:x.name,organization:x.organization,vision:x.vision,mission:x.mission,weeklyTheme:x.weekly_theme,goals:x.goals,knowledge:x.knowledge,updatedAt:date(x.updated_at)};}

export async function upsertStudioProfile(config:Config,phone:string,patch:Partial<Omit<StudioProfile,"phone"|"updatedAt">>):Promise<StudioProfile>{const db=getPool(config);if(!db)throw new Error("DATABASE_URL is not configured");await initializeStudioStore(config);const existing=await getStudioProfile(config,phone);const next={organization:"Mastery",goals:[],knowledge:[],...existing,...patch,phone};await db.query(`insert into studio_profiles(phone,name,organization,vision,mission,weekly_theme,goals,knowledge,updated_at) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now()) on conflict(phone) do update set name=excluded.name,organization=excluded.organization,vision=excluded.vision,mission=excluded.mission,weekly_theme=excluded.weekly_theme,goals=excluded.goals,knowledge=excluded.knowledge,updated_at=now()`,[phone,next.name??null,next.organization??null,next.vision??null,next.mission??null,next.weeklyTheme??null,JSON.stringify(next.goals??[]),JSON.stringify(next.knowledge??[])]);return (await getStudioProfile(config,phone))!;}

export async function studioContextForPhone(config:Config,phone:string):Promise<Record<string,unknown>>{const [profile,state]=await Promise.all([getStudioProfile(config,phone),getStudioState(config)]);if(!profile&&!state)return{};return{member:{phone,name:profile?.name},organization:{name:state?.organization??profile?.organization??"Mastery"},studio:{vision:state?.vision??profile?.vision??DEFAULT_MASTERY_VISION,mission:state?.mission??profile?.mission??null,weeklyTheme:state?.weeklyTheme??profile?.weeklyTheme??null,knowledge:state?.knowledge??[],updatedAt:state?.updatedAt},profile:{goals:profile?.goals??[],knowledge:profile?.knowledge??[],updatedAt:profile?.updatedAt}};}
