// A daily copy of the public Grok Bot Marketplace (x.ai/bot/marketplace), shown in Templates beside the community
// teams. Nothing is added on its own: each listing becomes a one-bot package the person previews and adds like any
// other template. The pages are read with an honest user agent, one at a time, once a day; a failed read keeps the
// copy from the day before.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { parseBotPackage, type ParsedBotPackage } from "./bot-package.ts";
import type { TeamCatalogEntry } from "./team-library.ts";
import { MAUS_COLOR_NAMES } from "../shared/wire.ts";

export const GROK_MARKETPLACE_ORIGIN = "https://x.ai";
const LISTING_PATH = "/bot/marketplace";
const USER_AGENT = "OpenMausBot-template-sync/1.0 (+https://github.com/MarkTaylorTsai/OpenMausBot)";
const SLUG = /^[a-z0-9][a-z0-9-]{0,70}$/;
const MAX_PAGE_BYTES = 4_000_000;
const MAX_BOTS = 300;
const DAY_MS = 24 * 60 * 60_000;
export const GROK_SLUG_PREFIX = "grok-";

const text = (max: number) => z.string().max(max * 4).transform((value) => value.trim());
const templateSchema = z.object({
  id: z.string().regex(SLUG),
  name: text(200).pipe(z.string().min(1)),
  creatorName: text(200).catch(""),
  description: text(4_000).catch(""),
  summary: text(2_000).catch(""),
  categories: z.array(text(80)).max(20).catch([]),
  color: z.string().max(40).catch(""),
  updatedAt: z.string().max(40).catch(""),
  instructions: text(24_000).catch(""),
  memories: z.array(z.object({ description: text(8_000) })).max(200).catch([]),
  skills: z.array(z.object({ name: text(200), description: text(2_000).catch(""), content: text(200_000).catch("") })).max(100).catch([]),
  routines: z.array(z.object({ name: text(200), summary: text(2_000).catch("") })).max(100).catch([]),
  integrations: z.array(z.object({ name: text(200), description: text(2_000).catch("") })).max(50).catch([]),
});
export type GrokTemplate = z.output<typeof templateSchema>;

export interface GrokMarketplaceCache {
  format: "omb.grok-marketplace";
  version: 1;
  syncedAt: number | null;
  lastAttemptAt: number | null;
  lastError?: string;
  bots: GrokTemplate[];
}

type Fetcher = typeof fetch;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cachePath = (dataDir: string) => join(dataDir, "grok-marketplace", "catalog.json");
const emptyCache = (): GrokMarketplaceCache => ({ format: "omb.grok-marketplace", version: 1, syncedAt: null, lastAttemptAt: null, bots: [] });

export function readGrokMarketplace(dataDir: string): GrokMarketplaceCache {
  try {
    const raw = JSON.parse(readFileSync(cachePath(dataDir), "utf8")) as Partial<GrokMarketplaceCache>;
    if (raw.format !== "omb.grok-marketplace" || !Array.isArray(raw.bots)) return emptyCache();
    const bots = raw.bots.flatMap((bot) => { const parsed = templateSchema.safeParse(bot); return parsed.success ? [parsed.data] : []; });
    return { ...emptyCache(), syncedAt: raw.syncedAt ?? null, lastAttemptAt: raw.lastAttemptAt ?? null, ...(raw.lastError ? { lastError: raw.lastError } : {}), bots };
  } catch {
    return emptyCache();
  }
}

function writeCache(dataDir: string, cache: GrokMarketplaceCache): void {
  mkdirSync(join(dataDir, "grok-marketplace"), { recursive: true });
  writeFileAtomic(cachePath(dataDir), `${JSON.stringify(cache, null, 1)}\n`);
}

async function fetchPage(path: string, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(`${GROK_MARKETPLACE_ORIGIN}${path}`, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw Object.assign(new Error(`x.ai returned HTTP ${response.status} for ${path}`), { status: response.status });
  const body = await response.text();
  if (body.length > MAX_PAGE_BYTES) throw new Error(`x.ai returned a page too large to read for ${path}`);
  return body;
}

/** Every marketplace bot the listing page links to, in page order. */
export function listingSlugs(html: string): string[] {
  const slugs = new Set<string>();
  for (const match of html.matchAll(/\/bot\/marketplace\/bots\/([a-z0-9][a-z0-9-]*)/g)) if (SLUG.test(match[1]!)) slugs.add(match[1]!);
  return [...slugs].slice(0, MAX_BOTS);
}

/** The page's React Server Components payload, joined back into one string. */
function flightPayload(html: string): string {
  let joined = "";
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { joined += JSON.parse(match[1]!) as string; } catch { /* a chunk that is not a string adds nothing */ }
  }
  return joined;
}

/** The JSON object that starts at `start`, found by matching braces outside strings. */
function objectAt(source: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

/** The template a bot's marketplace page renders: its instructions, memories, skills, routines and apps. */
export function parseTemplatePage(html: string, slug: string): GrokTemplate {
  const payload = flightPayload(html);
  let from = 0;
  for (;;) {
    const at = payload.indexOf('"template":{"id":', from);
    if (at < 0) break;
    from = at + 1;
    const raw = objectAt(payload, at + '"template":'.length);
    if (!raw) continue;
    try {
      const parsed = templateSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.id === slug) return parsed.data;
    } catch { /* keep looking */ }
  }
  throw new Error(`The marketplace page for ${slug} did not include its template`);
}

export interface SyncOptions { fetcher?: Fetcher; pauseMs?: number; now?: () => number; log?: (line: string) => void }

/** Reads the listing, then each bot page; a page that fails keeps yesterday's copy of that bot. */
export async function syncGrokMarketplace(dataDir: string, options: SyncOptions = {}): Promise<GrokMarketplaceCache> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const previous = readGrokMarketplace(dataDir);
  const attempt = { ...previous, lastAttemptAt: now() };
  let slugs: string[];
  try {
    slugs = listingSlugs(await fetchPage(LISTING_PATH, fetcher));
    if (slugs.length === 0) throw new Error("The marketplace listing had no bots; its page may have changed");
  } catch (error) {
    const failed = { ...attempt, lastError: error instanceof Error ? error.message : String(error) };
    writeCache(dataDir, failed);
    options.log?.(`grok marketplace: ${failed.lastError}`);
    return failed;
  }
  const known = new Map(previous.bots.map((bot) => [bot.id, bot]));
  const bots: GrokTemplate[] = [];
  const failures: string[] = [];
  for (const [index, slug] of slugs.entries()) {
    if (index > 0) await sleep(options.pauseMs ?? 1_500);
    try {
      bots.push(parseTemplatePage(await fetchPage(`/bot/marketplace/bots/${slug}`, fetcher), slug));
    } catch (error) {
      failures.push(slug);
      const kept = known.get(slug);
      if (kept) bots.push(kept);
      options.log?.(`grok marketplace: ${slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const { lastError: _dropped, ...rest } = attempt;
  const cache: GrokMarketplaceCache = {
    ...rest,
    syncedAt: now(),
    ...(failures.length ? { lastError: `${failures.length} of ${slugs.length} bot pages could not be read: ${failures.slice(0, 5).join(", ")}` } : {}),
    bots,
  };
  writeCache(dataDir, cache);
  options.log?.(`grok marketplace: ${bots.length} bots synced${failures.length ? `, ${failures.length} kept from the last sync` : ""}`);
  return cache;
}

/** Checks hourly and syncs once a day; the first check runs shortly after start. Returns a stop function. */
export function startGrokMarketplaceSync(dataDir: string, options: SyncOptions & { firstCheckMs?: number } = {}): () => void {
  if (process.env.OMB_GROK_MARKETPLACE_SYNC === "0") return () => {};
  const now = options.now ?? Date.now;
  let running = false;
  const check = () => {
    if (running) return;
    const last = readGrokMarketplace(dataDir).lastAttemptAt;
    if (last !== null && now() - last < DAY_MS) return;
    running = true;
    void syncGrokMarketplace(dataDir, { log: (line) => console.log(line), ...options })
      .catch((error) => console.warn("grok marketplace sync failed:", error instanceof Error ? error.message : String(error)))
      .finally(() => { running = false; });
  };
  const first = setTimeout(check, options.firstCheckMs ?? 90_000);
  const hourly = setInterval(check, 60 * 60_000);
  first.unref?.();
  hourly.unref?.();
  return () => { clearTimeout(first); clearInterval(hourly); };
}

const oneLine = (value: string, max: number) => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);
const encoder = new TextEncoder();
const clipBytes = (value: string, max: number) => {
  if (encoder.encode(value).length <= max) return value;
  let cut = value.slice(0, max);
  while (encoder.encode(cut).length > max - 3) cut = cut.slice(0, Math.floor(cut.length * 0.95));
  return `${cut}…`;
};
const slugify = (value: string, max: number) =>
  value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");

const COLORS: Record<string, (typeof MAUS_COLOR_NAMES)[number]> = {
  violet: "purple", purple: "purple", indigo: "blue", blue: "blue", sky: "cyan", cyan: "cyan", teal: "teal", green: "green",
  emerald: "green", lime: "green", yellow: "yellow", amber: "orange", orange: "orange", red: "red", rose: "pink", pink: "pink",
  fuchsia: "pink", coral: "coral", gray: "silver", grey: "silver", slate: "silver", silver: "silver",
};

export const grokPageUrl = (id: string) => `${GROK_MARKETPLACE_ORIGIN}/bot/marketplace/bots/${id}`;
/** A bot's own category, not the "From Grok Bot Team" shelf most official bots are also on. */
const primaryCategory = (bot: GrokTemplate) => bot.categories.find((value) => !/^from /i.test(value)) || bot.categories[0] || "";
const tagline = (bot: GrokTemplate) => bot.summary || bot.description || `${bot.name} from the Grok Bot Marketplace`;

/** One template as an ordinary one-bot package: its standing instructions carry the template's instructions and
 * memories, its skills the template's playbooks, and the template's routines and apps are listed for the person. */
export function grokTemplatePackage(bot: GrokTemplate): ParsedBotPackage {
  const url = grokPageUrl(bot.id);
  const usedNames = new Set<string>();
  const skills = bot.skills.slice(0, 20).flatMap((skill) => {
    let name = slugify(skill.name, 56) || "playbook";
    for (let n = 2; usedNames.has(name); n += 1) name = `${slugify(skill.name, 52) || "playbook"}-${n}`;
    usedNames.add(name);
    const description = oneLine(skill.description || skill.name, 1_000);
    const body = skill.content || skill.description || skill.name;
    return [{ name, description, source: url, instructions: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${skill.name}\n\n${clipBytes(body, 200_000)}\n` }];
  });
  const soul = clipBytes([
    `You are ${bot.name}, set up from the Grok Bot Marketplace template by ${bot.creatorName || "its creator"} (${url}).`,
    bot.instructions,
    bot.memories.length ? `## What you already know\n${bot.memories.map((memory) => `- ${memory.description.replace(/\n+/g, " ")}`).join("\n")}` : "",
    bot.routines.length ? `## Routines the original ran (not scheduled here; offer to set them up when they would help)\n${bot.routines.map((routine) => `- ${routine.name}: ${routine.summary}`).join("\n")}` : "",
    "## Where you run\nThis template was written for Grok Bot. Tools it names that only Grok Bot has (the Grok CLI, Grok plugins, Grok Finance) may not exist on this computer: use what this computer and your connected apps provide, and say plainly when something the template expects is missing.",
  ].filter(Boolean).join("\n\n"), 23_500);
  const category = primaryCategory(bot) || "Grok Bot Marketplace";
  return parseBotPackage({
    format: "openmaus.package",
    version: 1,
    package: {
      id: `${GROK_SLUG_PREFIX}${bot.id}`.slice(0, 80),
      release: "1.0.0",
      name: clip(bot.name, 100),
      tagline: oneLine(tagline(bot), 160),
      summary: clip(bot.description || tagline(bot), 2_000),
      category: clip(`Grok Bot Marketplace · ${category}`, 80),
      author: { name: clip(bot.creatorName || "Grok Bot Marketplace", 100), url },
      license: "Grok Bot Marketplace template",
      tags: ["grok-bot-marketplace", ...bot.categories.map((value) => slugify(value, 40)).filter(Boolean)].slice(0, 30),
      outcomes: [oneLine(tagline(bot), 240)],
      setupMinutes: 5,
      requirements: {
        apps: bot.integrations.slice(0, 30).flatMap((app) => {
          const slug = slugify(app.name, 60);
          return slug ? [{ slug, label: clip(app.name, 100), reason: oneLine(app.description || `${bot.name} uses ${app.name}`, 240), optional: true }] : [];
        }).filter((app, index, all) => all.findIndex((other) => other.slug === app.slug) === index),
        capabilities: [],
      },
      agents: [{
        key: "bot",
        name: clip(bot.name, 100),
        title: clip(category, 200),
        description: clip(bot.description || tagline(bot), 4_000),
        soul,
        appearance: { color: COLORS[bot.color.toLowerCase()] ?? "blue" },
        ...(skills.length ? { skills: skills.map((skill) => skill.name) } : {}),
      }],
      ...(skills.length ? { skills: { version: 1, entries: skills } } : {}),
    },
  });
}

/** Template listings for the Templates panel, newest catalog order kept. */
export function grokCatalogEntries(cache: GrokMarketplaceCache): TeamCatalogEntry[] {
  return cache.bots.map((bot) => ({
    slug: `${GROK_SLUG_PREFIX}${bot.id}`,
    name: clip(bot.name, 100),
    summary: oneLine(tagline(bot), 300),
    category: clip(`Grok Bot Marketplace · ${primaryCategory(bot) || "Bots"}`, 80),
    ...(bot.creatorName ? { outcome: oneLine(`${bot.creatorName} · ${tagline(bot)}`, 300) } : {}),
    setupMinutes: 5,
    manifest: grokPageUrl(bot.id),
    readme: grokPageUrl(bot.id),
    members: 1,
    skills: bot.skills.map((skill) => skill.name).slice(0, 20),
    requires: { apps: bot.integrations.map((app) => app.name).slice(0, 30) },
    card: {
      color: COLORS[bot.color.toLowerCase()] ?? "blue",
      creator: clip(bot.creatorName, 100),
      group: clip(primaryCategory(bot) || "Bots", 60),
      description: clip(bot.description || tagline(bot), 600),
      routines: bot.routines.length,
    },
  }));
}

/** The package for one `grok-<id>` slug from the local copy, or null when it is not there. */
export function grokLibraryTeam(dataDir: string, slug: string): ParsedBotPackage | null {
  if (!slug.startsWith(GROK_SLUG_PREFIX)) return null;
  const bot = readGrokMarketplace(dataDir).bots.find((entry) => entry.id === slug.slice(GROK_SLUG_PREFIX.length));
  return bot ? grokTemplatePackage(bot) : null;
}
