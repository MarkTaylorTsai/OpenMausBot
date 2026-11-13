import { afterEach, describe, expect, it, vi } from "vitest";

import { readTabList } from "./browser-tab-sync.ts";

afterEach(() => vi.unstubAllGlobals());

function engine(status: Record<string, unknown>) {
  const actions: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const { action } = JSON.parse(init.body) as { action: string };
    actions.push(action);
    return new Response(JSON.stringify(action === "stream_status" ? status : { success: true, data: { tabs: [] } }));
  }));
  return actions;
}

describe("reading the tab list for a live view", () => {
  it("asks for the tabs of a connected Chrome, so a page that closed itself leaves the view", async () => {
    const actions = engine({ success: true, data: { connected: true } });
    expect(await readTabList(4000, () => true)).toBe(true);
    expect(actions).toEqual(["stream_status", "tab_list"]);
  });

  it("sends no command to a Chrome that is not connected, which a command would start", async () => {
    const actions = engine({ success: true, data: { connected: false } });
    expect(await readTabList(4000, () => true)).toBe(false);
    expect(actions).toEqual(["stream_status"]);
  });

  it("stays out of the way once an action began during the status read", async () => {
    const actions = engine({ success: true, data: { connected: true } });
    expect(await readTabList(4000, () => false)).toBe(false);
    expect(actions).toEqual(["stream_status"]);
  });
});
