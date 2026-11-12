import { memo, useMemo } from "react";
import { t } from "@/lib/i18n";
import { openRoomThread, type Message } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { ThreadChip } from "./ThreadChip";
import { ToolActivity } from "./ToolActivity";
import { FailedTurnRow } from "./ChatView";
import { botEngine, failedTurnCause } from "@/lib/failed-turn";
import { cn } from "@/lib/cn";
import { HandoffChip } from "./HandoffReply";
import { TeammateChip } from "./TeammateChip";
import { useStoreRef } from "@/state/store-ref";
import { sameFields, useStoreSelector } from "@/state/store-select";

export const RoomToolChip = memo(function RoomToolChip({ message, roomId, threadId, live = false }: { message: Message; roomId?: string; threadId?: string; live?: boolean }) {
  const store = useStoreRef();
  const tool = message.tool;
  const failed = tool !== undefined && !message.threadRef && !message.relay && failedTurnCause(tool.name) !== null;
  const speakerId = message.from?.botId, withBotId = message.comm?.withBotId;
  const { engine, withBot } = useStoreSelector((s) => ({
    engine: failed ? botEngine(s.bots.find((b) => b.id === speakerId), s.instances) : undefined,
    withBot: withBotId ? s.bots.find((b) => b.id === withBotId) : undefined,
  }), sameFields);
  const withBots = useMemo(() => withBot ? [withBot] : [], [withBot]);
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} />; if (message.relay) return <TeammateChip message={message} />;
  if (failedTurnCause(tool.name) !== null) {
    return <FailedTurnRow tool={tool} engine={engine} botId={message.from?.botId} messageAt={message.at} />;
  }
  const comm = message.comm;
  if (comm && comm.groupId !== roomId) {
    return <HandoffChip message={message} bots={withBots} title={t("room.openBot", { name: comm.withName })} onClick={() => openRoomThread(store.dispatch, comm, store.state().groups)} />;
  }
  if (!comm) return <ToolActivity tool={tool} live={live} source={threadId ? { threadId, messageId: message.id } : undefined} />;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "ui-pill",
          tool.ok === false && "text-danger",
        )}
      >
        {comm && <BotAvatar bot={withBot ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />}
        <span className={cn("max-w-[480px] truncate", !comm && "font-mono")}>{tool.name}</span>
      </div>
    </div>
  );
});
