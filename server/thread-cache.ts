import type { ThreadRows } from "./message-db.ts";
import type { Message } from "./store.ts";

export interface ThreadState {
  messages: Message[];
  activeLeafId: string | null;
}

/** The messages from the first down to the active leaf. A parent is almost always stored before its child, so one pass
 * from the end finds the whole chain; a message inserted after its children were stored takes the indexed walk. */
export function activePathOf(state: ThreadState): Message[] {
  const { messages } = state;
  const path: Message[] = [];
  let want = state.activeLeafId;
  for (let i = messages.length - 1; i >= 0 && want; i -= 1) {
    const message = messages[i]!;
    if (message.id !== want) continue;
    path.push(message);
    want = message.parentId ?? null;
  }
  const missing = want;
  if (!missing || !messages.some((message) => message.id === missing)) return path.reverse();
  const byId = new Map(messages.map((m) => [m.id, m]));
  path.length = 0;
  let cur = state.activeLeafId ? byId.get(state.activeLeafId) : undefined;
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

/** A conversation nobody read or wrote for this long gives its parsed transcript back; the next read reloads it from messages.db. */
export const THREAD_IDLE_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;

export class ThreadCache {
  private entries = new Map<string, { state: ThreadState; usedAt: number }>();
  private sweptAt = Date.now();
  private readonly busyThreadIds: () => ReadonlySet<string>;

  constructor(busyThreadIds: () => ReadonlySet<string>) {
    this.busyThreadIds = busyThreadIds;
  }

  get(threadId: string): ThreadState | undefined {
    const now = Date.now();
    this.sweep(now);
    const entry = this.entries.get(threadId);
    if (entry) entry.usedAt = now;
    return entry?.state;
  }

  /** Rows stored without a parentId chain onto the row before them. */
  load(threadId: string, rows: ThreadRows): ThreadState {
    const { messages } = rows;
    let prev: string | null = null;
    for (const m of messages) {
      if (m.parentId === undefined) m.parentId = prev;
      prev = m.id;
    }
    const state = { messages, activeLeafId: rows.activeLeafId || (messages.at(-1)?.id ?? null) };
    this.entries.set(threadId, { state, usedAt: Date.now() });
    return state;
  }

  delete(threadId: string): void {
    this.entries.delete(threadId);
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    if (now - this.sweptAt < SWEEP_EVERY_MS) return;
    this.sweptAt = now;
    let busy: ReadonlySet<string> | undefined;
    for (const [threadId, entry] of this.entries) {
      if (now - entry.usedAt < THREAD_IDLE_MS) continue;
      busy ??= this.busyThreadIds();
      if (!busy.has(threadId)) this.entries.delete(threadId);
    }
  }
}
