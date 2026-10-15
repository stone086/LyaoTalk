import { useEffect, useMemo, useRef } from "react";
import { format, isSameDay } from "date-fns";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { ChatMessage, Conversation } from "@/stores/chatStore";

interface VirtualMessageListProps {
  messages: ChatMessage[];
  conversation: Conversation;
  highlightId?: string | null;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  renderMessage: (msg: ChatMessage, previous?: ChatMessage) => React.ReactNode;
  todayLabel: string;
  yesterdayLabel: string;
  unreadLabel: string;
  loadingLabel: string;
  loadOlderLabel: string;
}

export default function VirtualMessageList({
  messages,
  conversation,
  highlightId,
  hasMore,
  loadingOlder,
  onLoadOlder,
  renderMessage,
  todayLabel,
  yesterdayLabel,
  unreadLabel,
  loadingLabel,
  loadOlderLabel,
}: VirtualMessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const unreadStartIdx = useMemo(
    () => (conversation.unreadCount > 0 ? Math.max(messages.length - conversation.unreadCount, 0) : -1),
    [conversation.unreadCount, messages.length]
  );

  useEffect(() => {
    if (!highlightId) return;
    const index = messages.findIndex((message) => message.id === highlightId);
    if (index >= 0) {
      virtuosoRef.current?.scrollToIndex({ index, align: "center", behavior: "smooth" });
    }
  }, [highlightId, messages]);

  return (
    <Virtuoso
      ref={virtuosoRef}
      className="flex-1"
      data={messages}
      followOutput={(atBottom) => (atBottom ? "smooth" : false)}
      initialTopMostItemIndex={Math.max(messages.length - 1, 0)}
      startReached={() => {
        if (hasMore && !loadingOlder) onLoadOlder();
      }}
      components={{
        Header: () =>
          hasMore ? (
            <div className="flex justify-center py-2">
              <button
                onClick={onLoadOlder}
                disabled={loadingOlder}
                className="text-xs text-surface-200/40 hover:text-surface-200 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-900 hover:bg-surface-800 transition-colors disabled:opacity-60"
              >
                {loadingOlder ? loadingLabel : loadOlderLabel}
              </button>
            </div>
          ) : null,
        Footer: () => <div className="h-2" />,
      }}
      itemContent={(index, msg) => {
        const previous = messages[index - 1];
        const showDate = !previous || !isSameDay(msg.timestamp, previous.timestamp);
        const showUnreadDivider = unreadStartIdx === index && conversation.unreadCount > 0;
        return (
          <div className="px-4 animate-fade-in" data-mid={msg.id}>
            {showDate && (
              <div className="flex items-center gap-3 py-2 my-1">
                <div className="flex-1 h-px bg-surface-800/40" />
                <span className="text-[10px] text-surface-200/30 px-2 py-0.5 rounded-full bg-surface-900">
                  {dateLabel(msg.timestamp, todayLabel, yesterdayLabel)}
                </span>
                <div className="flex-1 h-px bg-surface-800/40" />
              </div>
            )}
            {showUnreadDivider && (
              <div className="flex items-center gap-3 py-2">
                <div className="flex-1 h-px bg-accent/40" />
                <span className="text-[10px] text-accent-soft px-2 py-0.5 rounded-full bg-accent/10">{unreadLabel}</span>
                <div className="flex-1 h-px bg-accent/40" />
              </div>
            )}
            {renderMessage(msg, previous)}
          </div>
        );
      }}
    />
  );
}

function dateLabel(timestamp: number, todayLabel: string, yesterdayLabel: string) {
  const date = new Date(timestamp);
  const now = new Date();
  if (isSameDay(date, now)) return todayLabel;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return yesterdayLabel;
  return format(date, "yyyy-MM-dd");
}
