import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";
import { activePathOf, THREAD_IDLE_MS } from "./thread-cache.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("Store message cache", () => {
  let now: number;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    now = Date.UTC(2026, 9, 1, 9);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const later = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };

  it("lets an idle conversation go and reloads it unchanged", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Idle" });
    const other = store.createTask(bot.id, "Other", false)!;
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "first" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "reply" });
    store.patchMessage(bot.threadId, reply.id, { text: "edited reply" });
    store.branchMessage(bot.threadId, first.id, "second try");
    for (let i = 0; i < 5; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: `frame-${i}`, mime: "image/png" });
    const before = store.messagesFor(bot.threadId);
    const snapshot = structuredClone({ messages: before, leaf: store.activeLeaf(bot.threadId), path: store.activePath(bot.threadId) });

    later(THREAD_IDLE_MS + 1);
    store.messagesFor(other.threadId);

    const after = store.messagesFor(bot.threadId);
    expect(after).not.toBe(before);
    expect({ messages: after, leaf: store.activeLeaf(bot.threadId), path: store.activePath(bot.threadId) }).toEqual(snapshot);
  });

  it("keeps a conversation someone used within the idle window", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Recent" });
    const other = store.createTask(bot.id, "Other", false)!;
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hello" });
    const before = store.messagesFor(bot.threadId);

    later(THREAD_IDLE_MS / 2);
    store.messagesFor(bot.threadId);
    later(THREAD_IDLE_MS / 2 + 1);
    store.messagesFor(other.threadId);

    expect(store.messagesFor(bot.threadId)).toBe(before);
  });

  it("keeps a conversation whose turn is still running, however long it is quiet", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Busy" });
    const other = store.createTask(bot.id, "Other", false)!;
    const room = store.createGroup("Room", [bot.id]);
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "long job" });
    store.appendMessage(room.threadId, { role: "user", kind: "text", text: "room job" });
    store.setTaskActivity(bot.id, bot.threadId, "working");
    store.patchGroup(room.id, { busyBotId: bot.id });
    const direct = store.messagesFor(bot.threadId);
    const roomLines = store.messagesFor(room.threadId);

    later(THREAD_IDLE_MS * 3);
    store.messagesFor(other.threadId);

    expect(store.messagesFor(bot.threadId)).toBe(direct);
    expect(store.messagesFor(room.threadId)).toBe(roomLines);
  });

  it("writes that land after a reload are kept", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Writer" });
    const other = store.createTask(bot.id, "Other", false)!;
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "before" });

    later(THREAD_IDLE_MS + 1);
    store.messagesFor(other.threadId);
    const added = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "after" });

    expect(store.messagesFor(bot.threadId).map((message) => message.text)).toEqual(
      new Store(selection).messagesFor(bot.threadId).map((message) => message.text),
    );
    expect(store.activeLeaf(bot.threadId)).toBe(added.id);
  });
});

describe("activePathOf", () => {
  type Row = Parameters<typeof activePathOf>[0]["messages"][number];
  const row = (id: string, parentId: string | null | undefined): Row => ({ id, parentId, at: 0, role: "user", kind: "text", text: id }) as Row;
  const indexedWalk = (messages: Row[], activeLeafId: string | null) => {
    const byId = new Map(messages.map((m) => [m.id, m]));
    const path: Row[] = [];
    let cur = activeLeafId ? byId.get(activeLeafId) : undefined;
    while (cur) {
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path.reverse();
  };
  const ids = (messages: Row[]) => messages.map((m) => m.id);

  it("follows the active branch, past sibling branches", () => {
    const messages = [row("a", null), row("b", "a"), row("c", "b"), row("b2", "a"), row("c2", "b2")];
    expect(ids(activePathOf({ messages, activeLeafId: "c2" }))).toEqual(["a", "b2", "c2"]);
    expect(ids(activePathOf({ messages, activeLeafId: "c" }))).toEqual(["a", "b", "c"]);
    expect(activePathOf({ messages, activeLeafId: null })).toEqual([]);
    expect(activePathOf({ messages, activeLeafId: "gone" })).toEqual([]);
    expect(activePathOf({ messages: [], activeLeafId: "a" })).toEqual([]);
  });

  it("follows a message stored after the children it was inserted above", () => {
    const messages = [row("a", null), row("b", "a"), row("d", "c"), row("e", "d"), row("c", "b")];
    expect(ids(activePathOf({ messages, activeLeafId: "e" }))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("stops where a page of the conversation starts", () => {
    const messages = [row("m8", "m7"), row("m9", "m8"), row("m10", "m9")];
    expect(ids(activePathOf({ messages, activeLeafId: "m10" }))).toEqual(["m8", "m9", "m10"]);
  });

  it("gives the indexed walk's path for any acyclic conversation, in any stored order", () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let round = 0; round < 300; round += 1) {
      const messages: Row[] = [];
      const size = 1 + rand(40);
      for (let i = 0; i < size; i += 1) {
        const pick = rand(10);
        messages.push(row(`m${i}`, i === 0 || pick === 0 ? null : pick === 1 ? "elsewhere" : pick < 6 ? `m${i - 1}` : `m${rand(i)}`));
      }
      for (let swaps = rand(4); swaps > 0; swaps -= 1) {
        const a = rand(size), b = rand(size);
        [messages[a], messages[b]] = [messages[b]!, messages[a]!];
      }
      const activeLeafId = `m${rand(size)}`;
      expect(activePathOf({ messages, activeLeafId })).toEqual(indexedWalk(messages, activeLeafId));
    }
  });
});
