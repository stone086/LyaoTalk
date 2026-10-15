import { useState, useCallback } from "react";
import { getClient } from "@/services/xmppAdapter";
import { useAccountStore } from "@/stores/accountStore";
import { useChatStore } from "@/stores/chatStore";

/**
 * Hook for loading MAM (Message Archive Management) history.
 * Call fetchHistory() to load older messages for a conversation.
 */
export function useMAM(peerJid: string, conversationId: string) {
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [oldestStanzaId, setOldestStanzaId] = useState<string | undefined>();
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const messages = useChatStore((s) => s.messages[conversationId] ?? []);

  const fetchHistory = useCallback(async () => {
    if (!activeAccountId || loading || !hasMore) return;
    const client = getClient(activeAccountId);
    if (!client?.connected) return;

    setLoading(true);

    const before = oldestStanzaId ?? messages[0]?.id;

    return new Promise<void>((resolve) => {
      let count = 0;
      const timeout = window.setTimeout(() => {
        unsubMsg();
        unsubDone();
        setLoading(false);
        resolve();
      }, 10000);

      const unsubMsg = client.on("mam.message", (data: any) => {
        count++;
        if (data.message.stanzaId && count === 1) {
          setOldestStanzaId(data.message.stanzaId);
        }
      });

      const unsubDone = client.on("mam.loaded", () => {
        window.clearTimeout(timeout);
        unsubMsg();
        unsubDone();
        setLoading(false);
        if (count < 30) setHasMore(false);
        resolve();
      });

      client.fetchMAM(peerJid, { before, limit: 30 });
    });
  }, [activeAccountId, peerJid, conversationId, loading, hasMore, oldestStanzaId, messages]);

  return { fetchHistory, loading, hasMore };
}
