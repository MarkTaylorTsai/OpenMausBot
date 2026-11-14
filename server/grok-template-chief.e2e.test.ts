import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const template = {
  id: "researchy", name: "Researchy", creatorName: "Farzad", description: "A research and fact-check desk.", summary: "A research and fact-check desk.",
  categories: ["Engineering"], color: "violet", updatedAt: "2026-09-05T00:02:09.796Z", instructions: "",
  memories: [{ description: "Every research pass uses live web search." }],
  skills: [{ name: "Research pass", description: "Use when researching.", content: "Search, read the sources, then deliver dated claims." }],
  routines: [], integrations: [],
};

it("a Chief adds a Grok Bot Marketplace bot itself, whole, into a team it manages", async () => {
  const gates = mkdtempSync(join(tmpdir(), "omb-grok-chief-gates-"));
  const gate = join(gates, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate, OMB_GROK_MARKETPLACE_SYNC: "0" });
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url,
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  try {
    mkdirSync(join(fixture.info.dataDir, "grok-marketplace"), { recursive: true });
    writeFileSync(join(fixture.info.dataDir, "grok-marketplace", "catalog.json"), JSON.stringify({ format: "omb.grok-marketplace", version: 1, syncedAt: 1, lastAttemptAt: 1, bots: [template] }));
    const chief = (await api("POST", "/api/bots", { name: "Clive", title: "Chief of Staff", section: "Operations" }, 201)).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, approvalMode: "ask" });
    if (existsSync(gate)) unlinkSync(gate);
    await runControlOmb(["send", "--bot", chief.id, "--task", chief.threadId, "--text", "Add the Researchy bot from the Grok marketplace.", "--url", fixture.info.url]);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN as string;

    const library = await api("GET", "/api/internal/team-library", undefined, 200, token);
    expect(library.grokBots).toEqual([expect.objectContaining({ template: "grok-researchy", name: "Researchy", by: "Farzad", category: "Engineering" })]);

    await api("POST", "/api/internal/create-bot", { template: "grok-missing" }, 404, token);
    const created = await api("POST", "/api/internal/create-bot", { template: "grok-researchy", name: "ç ”ç©¶å“¡", team: "Operations", instructions: "Reply in Traditional Chinese." }, 201, token);
    expect(created).toMatchObject({ name: "ç ”ç©¶å“¡", section: "Operations" });
    const bot = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === created.id);
    expect(bot.soul).toContain("You are Researchy, set up from the Grok Bot Marketplace template by Farzad");
    expect(bot.soul).toContain("Every research pass uses live web search.");
    expect(bot.soul).toContain("### Research pass");
    expect(bot.soul).toContain("## From your Chief of Staff\nReply in Traditional Chinese.");
  } finally {
    writeFileSync(gate, "finish");
    await fixture.close();
    removeTempDir(gates);
  }
}, 90_000);
