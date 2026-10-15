import toast from "react-hot-toast";
import { aiApi } from "@/services/api";
import type { ConjiPlugin } from "@/plugins/sdk";

export const aiSummaryPlugin: ConjiPlugin = {
  id: "ai-summary",
  name: "AI Summary",
  version: "1.0.0",
  getChatToolbarActions: () => [
    {
      id: "ai-summary:generate",
      label: "AI Summary",
      onClick: async (ctx) => {
        const texts = ctx.messages
          .map((m) => (m.body ?? "").trim())
          .filter(Boolean)
          .slice(-80);

        if (texts.length < 2) {
          toast.error("Not enough messages to summarize");
          return;
        }

        try {
          const res = await aiApi.summarize(texts, ctx.conversationId);
          const summary = (res?.summary ?? "").trim();
          if (!summary) {
            toast.error("AI returned empty summary");
            return;
          }
          ctx.addSystemMessage(`AI Summary\n${summary}`);
          toast.success("AI summary generated");
        } catch (err: any) {
          const message = err?.response?.data?.detail ?? err?.message ?? "AI summary failed";
          toast.error(message);
        }
      },
    },
  ],
};
