// Presets come from two places: the JSON files in presets/ (shipped, edited on disk) and the
// custom_presets table (created in the UI). Files are read first everywhere, so a stored row
// whose slug matches a file is never seen: the file wins.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Preset } from "@fireround/core";
import { PRESET_SLUG, parsePreset } from "@fireround/core";
import type { Db } from "@fireround/core/db";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { db } from "./db.ts";

const dir = () => path.join(process.cwd(), "presets");

const byOrder = (presets: Preset[]) => presets.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));

async function fileSlugs(): Promise<string[]> {
  return (await readdir(dir())).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}

async function loadFilePreset(slug: string): Promise<Preset | null> {
  try {
    return parsePreset(JSON.parse(await readFile(path.join(dir(), `${slug}.json`), "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** The file preset with this slug, else the custom one. `handle` defaults to the app database. */
export async function loadPreset(slug: string, handle?: Db): Promise<Preset> {
  if (!PRESET_SLUG.test(slug)) throw new Error(`invalid preset slug: ${slug}`);
  const fromFile = await loadFilePreset(slug);
  if (fromFile) return fromFile;
  const h = handle ?? (await db());
  const [row] = await h.select().from(schema.customPresets).where(eq(schema.customPresets.slug, slug)).limit(1);
  if (!row) throw new Error(`unknown preset: ${slug}`);
  return parsePreset(row.definition);
}

/** Every preset: the files by `order` (then slug), then the custom ones the same way, so the first file is the default. */
export async function listPresets(handle?: Db): Promise<Preset[]> {
  const files = (await Promise.all((await fileSlugs()).map(loadFilePreset))).filter((p): p is Preset => p !== null);
  const h = handle ?? (await db());
  const rows = await h.select().from(schema.customPresets);
  const shipped = new Set(files.map((p) => p.slug));
  const custom = rows.filter((r) => !shipped.has(r.slug)).map((r) => parsePreset(r.definition));
  return [...byOrder(files), ...byOrder(custom)];
}

/** Whether a slug is not one of the shipped files, so the UI may edit or delete it. */
export async function isCustomPreset(slug: string): Promise<boolean> {
  return !(await fileSlugs()).includes(slug);
}

/** Insert or replace a custom preset. Refuses a slug a file already owns, since the file would shadow the row. */
export async function saveCustomPreset(handle: Db, preset: Preset): Promise<void> {
  const definition = parsePreset(preset);
  if (!(await isCustomPreset(definition.slug)))
    throw new Error(`preset ${definition.slug} is a file; edit presets/${definition.slug}.json`);
  await handle
    .insert(schema.customPresets)
    .values({ slug: definition.slug, definition })
    .onConflictDoUpdate({ target: schema.customPresets.slug, set: { definition, updatedAt: new Date() } });
}

export async function deleteCustomPreset(handle: Db, slug: string): Promise<void> {
  await handle.delete(schema.customPresets).where(eq(schema.customPresets.slug, slug));
}

/** The lightweight shape client components need to label and switch presets. */
export interface PresetOption {
  slug: string;
  name: string;
}

export function presetOptions(presets: Preset[]): PresetOption[] {
  return presets.map((p) => ({ slug: p.slug, name: p.name }));
}
