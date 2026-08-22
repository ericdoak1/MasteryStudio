import { Pool } from "pg";
import type { Config } from "./config.js";

export const DEFAULT_MASTERY_VISION = "Mastery helps leaders turn who they are and what they believe into a clear, repeatable way of developing people, building strong teams, and improving performance.";

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

function getPool(config: Config): Pool | undefined {
  if (!config.databaseUrl) return undefined;
  if (!pool) pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  return pool;
}

export async function initializeStudioStore(config: Config): Promise<void> {
  const db = getPool(config);
  if (!db || initialized) return;
  await db.query(`
    create table if not exists studio_profiles (
      phone text primary key,
      name text,
      organization text,
      vision text,
      mission text,
      weekly_theme text,
      goals jsonb not null default '[]'::jsonb,
      knowledge jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists studio_profiles_updated_at_idx on studio_profiles(updated_at desc);
  `);
  initialized = true;
}

export async function getStudioProfile(config: Config, phone: string): Promise<StudioProfile | null> {
  const db = getPool(config);
  if (!db) return null;
  await initializeStudioStore(config);
  const result = await db.query(`
    select phone, name, organization, vision, mission, weekly_theme, goals, knowledge, updated_at
    from studio_profiles where phone = $1 limit 1
  `, [phone]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    phone: row.phone,
    name: row.name,
    organization: row.organization,
    vision: row.vision,
    mission: row.mission,
    weeklyTheme: row.weekly_theme,
    goals: row.goals,
    knowledge: row.knowledge,
    updatedAt: row.updated_at?.toISOString?.() ?? String(row.updated_at ?? "")
  };
}

export async function upsertStudioProfile(
  config: Config,
  phone: string,
  patch: Partial<Omit<StudioProfile, "phone" | "updatedAt">>
): Promise<StudioProfile> {
  const db = getPool(config);
  if (!db) throw new Error("DATABASE_URL is not configured");
  await initializeStudioStore(config);
  const existing = await getStudioProfile(config, phone);
  const next = {
    organization: "Mastery",
    vision: DEFAULT_MASTERY_VISION,
    goals: [],
    knowledge: [],
    ...existing,
    ...patch,
    phone
  };
  await db.query(`
    insert into studio_profiles (phone, name, organization, vision, mission, weekly_theme, goals, knowledge, updated_at)
    values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now())
    on conflict (phone) do update set
      name = excluded.name,
      organization = excluded.organization,
      vision = excluded.vision,
      mission = excluded.mission,
      weekly_theme = excluded.weekly_theme,
      goals = excluded.goals,
      knowledge = excluded.knowledge,
      updated_at = now()
  `, [
    phone,
    next.name ?? null,
    next.organization ?? "Mastery",
    next.vision ?? DEFAULT_MASTERY_VISION,
    next.mission ?? null,
    next.weeklyTheme ?? null,
    JSON.stringify(next.goals ?? []),
    JSON.stringify(next.knowledge ?? [])
  ]);
  return (await getStudioProfile(config, phone))!;
}

export async function ensureStudioProfile(config: Config, phone: string): Promise<StudioProfile | null> {
  if (!config.databaseUrl) return null;
  const existing = await getStudioProfile(config, phone);
  if (existing) {
    if (!existing.vision || !existing.organization) {
      return upsertStudioProfile(config, phone, {
        organization: existing.organization || "Mastery",
        vision: existing.vision || DEFAULT_MASTERY_VISION
      });
    }
    return existing;
  }
  return upsertStudioProfile(config, phone, { organization: "Mastery", vision: DEFAULT_MASTERY_VISION });
}

export async function studioContextForPhone(config: Config, phone: string): Promise<Record<string, unknown>> {
  const profile = await ensureStudioProfile(config, phone);
  if (!profile) return {};
  return {
    member: { phone: profile.phone, name: profile.name },
    organization: { name: profile.organization || "Mastery" },
    studio: {
      vision: profile.vision || DEFAULT_MASTERY_VISION,
      mission: profile.mission,
      weeklyTheme: profile.weeklyTheme,
      goals: profile.goals,
      knowledge: profile.knowledge,
      updatedAt: profile.updatedAt
    }
  };
}
