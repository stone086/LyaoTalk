import { useMemo, useCallback, useRef } from "react";
import { getClient } from "@/services/xmppAdapter";
import { useAccountStore } from "@/stores/accountStore";
import { useChatStore } from "@/stores/chatStore";
import { generateConversationId, normalizeBareJid } from "@/utils/helpers";

/**
 * Hook for sending and receiving typing indicators.
 * Automatically sends "composing" when user types,
 * "paused" after they stop for 3 seconds.
 */
export function useTypingIndicator(peerJid: string) {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const normalizedPeerJid = normalizeBareJid(peerJid);
  const conversationId = useMemo(
    () => (activeAccountId && normalizedPeerJid ? generateConversationId(activeAccountId, normalizedPeerJid) : ""),
    [activeAccountId, normalizedPeerJid]
  );
  const peerIsTyping = useChatStore((s) => (conversationId ? Boolean(s.typingPeers[conversationId]) : false));
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  const onInputChange = useCallback(() => {
    if (!activeAccountId) return;
    const client = getClient(activeAccountId);
    if (!client?.connected) return;

    if (!isTypingRef.current) {
      isTypingRef.current = true;
      client.sendTyping(normalizedPeerJid, true);
    }

    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      isTypingRef.current = false;
      client.sendTyping(normalizedPeerJid, false);
    }, 3000);
  }, [activeAccountId, normalizedPeerJid]);

  const onBlur = useCallback(() => {
    if (!activeAccountId) return;
    const client = getClient(activeAccountId);
    if (!client?.connected || !isTypingRef.current) return;
    isTypingRef.current = false;
    client.sendTyping(normalizedPeerJid, false);
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, [activeAccountId, normalizedPeerJid]);

  return { peerIsTyping, onInputChange, onBlur };
}
