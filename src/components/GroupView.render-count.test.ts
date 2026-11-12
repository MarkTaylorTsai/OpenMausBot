// @vitest-environment happy-dom
// The real provider and live stream with a room of two members on screen: what the room does not show must not draw
// it again, and one member's words arriving must not draw the messages already there again.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../shared/wire";
import type { Action, BotAnnouncement, InstanceInfo, Message } from "@/state/store";

const renders = vi.hoisted(() => ({ room: 0, transcript: 0, rows: {} as Record<string, number> }));
vi.mock("@/lib/drafts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/drafts")>();
  return { ...original, useReplyDraft: (...args: Parameters<typeof original.useReplyDraft>) => { renders.room++; return original.useReplyDraft(...args); } };
});
vi.mock("@/hooks/use-live-tool-ids", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/hooks/use-live-tool-ids")>();
  return { ...original, useLiveToolIds: (...args: Parameters<typeof original.useLiveToolIds>) => { renders.transcript++; return original.useLiveToolIds(...args); } };
});
vi.mock("./message-menu", async (importOriginal) => {
  const original = await importOriginal<typeof import("./message-menu")>();
  return {
    ...original,
    useBotMessageMenu: (...args: Parameters<typeof original.useBotMessageMenu>) => {
      const id = args[0].messageId ?? "";
      renders.rows[id] = (renders.rows[id] ?? 0) + 1;
      return original.useBotMessageMenu(...args);
    },
  };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: vi.fn() }));

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const announced = (id: string, name: string): BotAnnouncement => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: `${id}-thread`, title: "Chat", createdAt: 1, approvalMode: "ask" }],
});
const said = (id: string, botId: string, name: string, at: number): Message =>
  ({ id, at, role: "bot", kind: "text", text: `${id} words`, from: { botId, name, color: "green" } }) as Message;
const room = {
  id: "room", threadId: "room-thread", name: "Planning", memberIds: ["a", "b"], defaultResponder: { kind: "member", botId: "a" },
  bulletin: "", unread: false, createdAt: 1, setupCompletedAt: 1,
  messages: [{ id: "ask", at: 1, role: "user", kind: "text", text: "Plan the launch" }, said("a1", "a", "Ada", 2), said("b1", "b", "Bea", 3)],
};
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" }, models: { options: [{ id: "m", label: "Model" }] } } as unknown as InstanceInfo] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
};

const { StoreProvider, useStore } = await import("@/state/store");
const { useStoreSelector } = await import("@/state/store-select");
const { flushLiveReplies } = await import("@/state/live-reply");
const { GroupView } = await import("./GroupView");

let dispatch!: (action: Action) => void;
function Shown() {
  dispatch = useStore().dispatch;
  return null;
}
function Shell() {
  const group = useStoreSelector((state) => state.groups.find((candidate) => candidate.id === "room"));
  return group ? createElement(GroupView, { group }) : null;
}

let root: Root;
let cursor = 0;
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await task(); };
const stream = () => FixtureEventSource.opened[0]!;
const send = async (frame: object) => { stream().send(frame, `run:${++cursor}`); await settle(); };
const words = async (delta: string) => {
  await send({ kind: "runtime", event: { type: "content.delta", streamKind: "assistant_text", delta, botId: "b", itemId: "b2", eventId: `d${cursor}`, provider: "codex", threadId: "room-thread", turnId: "t1", createdAt: "2026-11-11T00:00:00.000Z" } });
  flushSync(() => flushLiveReplies());
  await settle();
};
const counts = () => ({ room: renders.room, transcript: renders.transcript, rows: { ...renders.rows } });
const liveRow = () => document.querySelector('[data-mid^="live:"]');

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string) => path.startsWith("/api/bots?")
    ? json({ bots: [announced("a", "Ada"), announced("b", "Bea"), announced("c", "Cy")].map((bot) => ({ ...bot, messages: [] })), groups: [room] })
    : json(answers[path.replace(/\?.*$/, "")] ?? {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Shown), createElement(Shell))));
  await settle();
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  flushSync(() => dispatch({ type: "select", id: "room" }));
  await settle();
});
afterAll(() => {
  flushSync(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("a room on screen", () => {
  it("is drawn, with a row for each member's message", () => {
    expect(document.querySelector('[data-mid="a1"]')).not.toBeNull();
    expect(document.querySelector('[data-mid="b1"]')).not.toBeNull();
    expect(renders.room).toBeGreaterThan(0);
    expect(renders.transcript).toBeGreaterThan(0);
    expect(renders.rows.a1).toBeGreaterThan(0);
    expect(renders.rows.b1).toBeGreaterThan(0);
  });

  it("does not draw again for a store change it does not show", async () => {
    const before = counts();
    flushSync(() => dispatch({ type: "connected", value: false }));
    flushSync(() => dispatch({ type: "connected", value: true }));
    await settle();
    expect(counts()).toEqual(before);
  });

  it("does not draw again for the turn of a bot that is not a member", async () => {
    // The mascot motion is one for the whole app: the first frame settles it.
    await send({ kind: "bot", bot: { ...announced("c", "Cy"), busy: true, activity: "working" } });
    const before = counts();
    await send({ kind: "bot", bot: { ...announced("c", "Cy"), busy: true, activity: "working", description: "Still working" } });
    await send({ kind: "message", threadId: "c-thread", message: { id: "c1", at: 9, role: "bot", kind: "text", text: "c1" } } as ServerFrame);
    await send({ kind: "bot", bot: { ...announced("c", "Cy"), busy: false, activity: "idle" } });
    expect(counts()).toEqual(before);
  });

  it("keeps its rows as they are while a member's turn starts and ends", async () => {
    const before = counts();
    await send({ kind: "bot", bot: { ...announced("a", "Ada"), busy: true, activity: "working" } });
    await send({ kind: "bot", bot: { ...announced("a", "Ada"), busy: false, activity: "idle" } });
    expect(counts().rows).toEqual(before.rows);
  });

  it("draws only the arriving reply as one member's words stream in", async () => {
    await send({ kind: "runtime", event: { type: "turn.started", eventId: "t1-start", provider: "codex", threadId: "room-thread", turnId: "t1", createdAt: "2026-11-11T00:00:00.000Z" } });
    await words("Bea is ");
    expect(liveRow()?.textContent).toContain("Bea is");
    const before = counts();
    await words("writing a longer ");
    await words("reply here. ");
    expect(liveRow()?.textContent).toContain("writing a longer reply here.");
    const after = counts();
    expect(after.room, "the room around the transcript").toBe(before.room);
    expect(after.rows.a1, "another member's saved message").toBe(before.rows.a1);
    expect(after.rows.b1, "the speaker's earlier saved message").toBe(before.rows.b1);
    expect(after.rows["live:b2"], "the reply still arriving").toBeGreaterThan(before.rows["live:b2"] ?? 0);
  });

  it("draws the new message and not the earlier ones when a reply is saved", async () => {
    await send({ kind: "message", threadId: "room-thread", message: said("a2", "a", "Ada", 20) } as ServerFrame);
    const before = counts();
    await send({ kind: "message", threadId: "room-thread", message: said("a3", "a", "Ada", 21) } as ServerFrame);
    expect(document.querySelector('[data-mid="a3"]')).not.toBeNull();
    const after = counts();
    expect(after.rows.a3).toBeGreaterThan(0);
    expect(after.rows.a1).toBe(before.rows.a1);
    expect(after.rows.b1).toBe(before.rows.b1);
  });
});
