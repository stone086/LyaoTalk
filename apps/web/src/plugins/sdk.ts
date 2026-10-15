import type { ChatMessage } from "@/stores/chatStore";

export interface ChatToolbarContext {
  accountId: string | null;
  conversationId: string;
  peerJid: string;
  messages: ChatMessage[];
  addSystemMessage: (body: string) => void;
}

export interface ChatToolbarAction {
  id: string;
  label: string;
  onClick: (ctx: ChatToolbarContext) => Promise<void> | void;
}

export interface ConjiPlugin {
  id: string;
  name: string;
  version: string;
  getChatToolbarActions?: (ctx: ChatToolbarContext) => ChatToolbarAction[];
}
