import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  grokCatalogEntries,
  grokLibraryTeam,
  grokTemplatePackage,
  listingSlugs,
  parseTemplatePage,
  readGrokMarketplace,
  syncGrokMarketplace,
  type GrokTemplate,
} from "./grok-marketplace.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const home = () => { const dir = mkdtempSync(join(tmpdir(), "omb-grok-")); homes.push(dir); return dir; };

const template = (id: string, extra: Partial<GrokTemplate> = {}) => ({
  id, name: `Bot ${id}`, creatorName: "Ada", handle: "ada", description: `Does ${id} work.`, summary: `Does ${id} work.`,
  categories: ["From Grok Bot Team", "Marketing"], installCount: 3, color: "violet", addHref: "/bot/x", imageUrl: "https://example.com/a.jpg",
  updatedAt: "2026-09-05T00:02:09.796Z", instructions: "",
  memories: [{ id: "memory-0", name: "memory 1", description: "Writes in a plain voice." }],
  skills: [{ id: "skill-0", name: "Draft a brief", description: "Use when drafting.", content: "Steps:\n1. Read.\n2. Write." }],
  routines: [{ id: "routine-0", name: "Weekly report", summary: "Fridays at 9." }],
  integrations: [{ id: "integration-0", name: "Google Sheets", description: "The tracker." }],
  ...extra,
});

/** A page shaped like x.ai's: the template sits inside the React Server Components payload, split across pushes. */
function page(body: object): string {
  const flight = `0:{"layout":"$L1"}\n6c:["$","$L6b",null,{"template":${JSON.stringify(body)},"featured":false}]\n`;
  const half = Math.floor(flight.length / 2);
  return `<html><body><a href="/bot/marketplace/bots/other">x</a><script>self.__next_f.push([1,${JSON.stringify(flight.slice(0, half))}])</script>`
    + `<script>self.__next_f.push([1,${JSON.stringify(flight.slice(half))}])</script></body></html>`;
}

describe("reading the Grok Bot Marketplace", () => {
  it("finds every bot the listing links to, once each", () => {
    const html = `<a href="/bot/marketplace/bots/seo-desk">a</a><a href="https://x.ai/bot/marketplace/bots/clip-bot">b</a><a href="/bot/marketplace/bots/seo-desk">c</a><a href="/bot/marketplace/sales">d</a>`;
    expect(listingSlugs(html)).toEqual(["seo-desk", "clip-bot"]);
  });

  it("reads a bot's template out of its page, braces and quotes inside strings included", () => {
    const parsed = parseTemplatePage(page(template("seo-desk", { instructions: 'Say "hi" {not a brace}' })), "seo-desk");
    expect(parsed.name).toBe("Bot seo-desk");
    expect(parsed.instructions).toBe('Say "hi" {not a brace}');
    expect(parsed.skills[0]!.content).toContain("2. Write.");
  });

  it("refuses a page whose template is another bot's", () => {
    expect(() => parseTemplatePage(page(template("other")), "seo-desk")).toThrow(/did not include its template/);
  });
});

describe("a template as a package", () => {
  it("becomes one bot whose standing instructions carry its memories and routines, with its playbooks as skills", () => {
    const pkg = grokTemplatePackage(parseTemplatePage(page(template("seo-desk")), "seo-desk")).package;
    expect(pkg.id).toBe("grok-seo-desk");
    expect(pkg.category).toBe("Grok Bot Marketplace · Marketing");
    expect(pkg.agents).toHaveLength(1);
    expect(pkg.agents[0]!.appearance.color).toBe("purple");
    expect(pkg.agents[0]!.soul).toContain("- Writes in a plain voice.");
    expect(pkg.agents[0]!.soul).toContain("Weekly report: Fridays at 9.");
    expect(pkg.agents[0]!.skills).toEqual(["draft-a-brief"]);
    expect(pkg.skills!.entries[0]!.instructions).toMatch(/^---\nname: draft-a-brief\n/);
    expect(pkg.requirements.apps).toEqual([{ slug: "google-sheets", label: "Google Sheets", reason: "The tracker.", optional: true }]);
    expect(pkg.routines).toBeUndefined();
  });

  it("keeps two playbooks with the same name apart", () => {
    const skill = { name: "Draft", description: "d", content: "c" };
    const pkg = grokTemplatePackage(parseTemplatePage(page(template("a", { skills: [skill, skill] })), "a")).package;
    expect(pkg.skills!.entries.map((entry) => entry.name)).toEqual(["draft", "draft-2"]);
  });
});

describe("the daily sync", () => {
  const site = (pages: Record<string, string | number>) => (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    const value = pages[path];
    if (typeof value === "string") return new Response(value);
    return new Response("no", { status: typeof value === "number" ? value : 404 });
  }) as typeof fetch;

  it("stores every bot, serves them as templates, and keeps yesterday's copy of a page that fails", async () => {
    const dir = home();
    const listing = `<a href="/bot/marketplace/bots/a">a</a><a href="/bot/marketplace/bots/b">b</a>`;
    await syncGrokMarketplace(dir, { pauseMs: 0, fetcher: site({ "/bot/marketplace": listing, "/bot/marketplace/bots/a": page(template("a")), "/bot/marketplace/bots/b": page(template("b")) }) });
    expect(readGrokMarketplace(dir).bots.map((bot) => bot.id)).toEqual(["a", "b"]);

    const second = await syncGrokMarketplace(dir, { pauseMs: 0, fetcher: site({ "/bot/marketplace": listing, "/bot/marketplace/bots/a": page(template("a", { name: "A renamed" })), "/bot/marketplace/bots/b": 500 }) });
    expect(second.bots.map((bot) => bot.name)).toEqual(["A renamed", "Bot b"]);
    expect(second.lastError).toMatch(/1 of 2 bot pages/);

    expect(grokCatalogEntries(second).map((entry) => entry.slug)).toEqual(["grok-a", "grok-b"]);
    expect(grokLibraryTeam(dir, "grok-b")?.package.name).toBe("Bot b");
    expect(grokLibraryTeam(dir, "grok-missing")).toBeNull();
    expect(grokLibraryTeam(dir, "seo-growth")).toBeNull();
  });

  it("keeps the whole copy when the listing cannot be read or comes back empty", async () => {
    const dir = home();
    await syncGrokMarketplace(dir, { pauseMs: 0, fetcher: site({ "/bot/marketplace": `<a href="/bot/marketplace/bots/a">a</a>`, "/bot/marketplace/bots/a": page(template("a")) }) });
    const failed = await syncGrokMarketplace(dir, { pauseMs: 0, fetcher: site({ "/bot/marketplace": 403 }) });
    expect(failed.bots).toHaveLength(1);
    expect(failed.lastError).toMatch(/HTTP 403/);
    const empty = await syncGrokMarketplace(dir, { pauseMs: 0, fetcher: site({ "/bot/marketplace": "<html></html>" }) });
    expect(empty.bots).toHaveLength(1);
    expect(empty.lastError).toMatch(/no bots/);
  });
});
