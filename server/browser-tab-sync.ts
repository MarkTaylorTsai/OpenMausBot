// agent-browser (0.36) learns that a page closed itself (a sign-in popup, window.close) only at its next command, so a live
// view kept showing a tab that was gone and closing it by hand failed. Reading the tab list makes the engine send the
// current one to every view.
import { relay } from "./browser-relay.ts";

const TAB_SYNC = { timeoutMs: 2_000, maxBytes: 262_144 };

/** Reads the tab list only while Chrome is connected, since a command would start a stopped one, and only while `free`
 * still holds after the status read: behind a bot's or a person's own action the read would queue in the daemon. */
export async function readTabList(port: number, free: () => boolean): Promise<boolean> {
  const status = await relay(port, { action: "stream_status" }, TAB_SYNC);
  if (!status.success || status.data?.connected !== true || !free()) return false;
  await relay(port, { action: "tab_list" }, TAB_SYNC);
  return true;
}
