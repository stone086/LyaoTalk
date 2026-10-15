/**
 * quick-reply plugin
 * Lets users define and send pre-configured reply templates.
 */

const DEFAULT_REPLIES = [
  "OK, got it!",
  "Thanks for letting me know.",
  "I'll check on this and get back to you.",
  "On my way!",
  "Can we schedule a call to discuss?",
  "Please send me more details.",
];

type PluginContext = any;

const quickReplyPlugin = {
  manifest: {
    id: "quick-reply",
    name: "Quick Reply",
    version: "1.0.0",
    description: "Send pre-configured quick reply templates with one click.",
    permissions: ["messages.send"],
    slots: ["chat.toolbar", "command.palette"],
  },

  async init(ctx: PluginContext) {
    console.log("[quick-reply] Plugin initialized");
    let config = await ctx.getConfig().catch(() => ({}));
    if (!config.replies) {
      await ctx.saveConfig({ replies: DEFAULT_REPLIES });
    }
  },

  destroy() {
    console.log("[quick-reply] Plugin destroyed");
  },

  render(slot: string, props: any) {
    if (slot === "chat.toolbar") {
      return {
        type: "dropdown",
        label: "Quick Reply",
        icon: "Zap",
        items: DEFAULT_REPLIES.map((r) => ({
          label: r,
          onClick: () => props.sendMessage(r),
        })),
      };
    }
    return null;
  },
};

export default quickReplyPlugin;
