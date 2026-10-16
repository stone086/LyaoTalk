/**
 * ai-summary plugin
 * Summarizes conversations using the backend AI service.
 * This is an example of how to build a LyaoTalk plugin.
 */
import { Plugin, registerPlugin } from "../../packages/plugin-sdk/src/index";

const aiSummaryPlugin: Plugin = {
  manifest: {
    id: "ai-summary",
    name: "AI Summary",
    version: "1.0.0",
    description: "Summarize conversations with AI. Adds a summary button to the chat toolbar.",
    author: "LyaoTalk Team",
    permissions: ["messages.read", "api.ai"],
    slots: ["chat.toolbar", "conversation.sidebar"],
  },

  async init(ctx) {
    console.log("[ai-summary] Plugin initialized");

    // Listen for when a long conversation is opened
    ctx.onEvent("conversation.opened", async (data: any) => {
      // Auto-trigger summary if conversation has many unread messages
      // (demo logic - customize as needed)
      if (data.unreadCount > 50) {
        ctx.notify("Long conversation detected. Click the AI button to summarize.", "info");
      }
    });
  },

  destroy() {
    console.log("[ai-summary] Plugin destroyed");
  },

  render(slot, props: any) {
    // In a real implementation, return React components
    // The host application calls this and mounts the result
    if (slot === "chat.toolbar") {
      return {
        type: "button",
        icon: "Bot",
        label: "Summarize",
        onClick: async () => {
          const convId = props.conversationId;
          const messages = props.messages?.map((m: any) => m.body).filter(Boolean) ?? [];
          const result = await props.ctx.callApi("/ai/summarize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages, conversation_id: convId }),
          });
          return result;
        },
      };
    }
    return null;
  },
};

registerPlugin(aiSummaryPlugin);
export default aiSummaryPlugin;
