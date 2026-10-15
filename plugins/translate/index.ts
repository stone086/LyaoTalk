/**
 * translate plugin
 * Adds a "Translate" button to the message toolbar.
 * Connects to the backend /ai/translate endpoint.
 */

type PluginContext = any;

const translatePlugin = {
  manifest: {
    id: "translate",
    name: "Translate",
    version: "1.0.0",
    description: "Auto-translate messages. Adds a translate button to each message.",
    permissions: ["messages.read", "api.ai"],
    slots: ["message.render.after", "chat.toolbar"],
  },

  init(ctx: PluginContext) {
    console.log("[translate] Plugin initialized");
  },

  destroy() {
    console.log("[translate] Plugin destroyed");
  },

  render(slot: string, props: any) {
    if (slot === "message.render.after") {
      return {
        type: "button",
        label: "Translate",
        icon: "Globe",
        onClick: async () => {
          const res = await props.ctx.callApi(
            `/ai/translate?text=${encodeURIComponent(props.message.body)}&target_lang=en`,
            { method: "POST" }
          );
          return res;
        },
      };
    }
    return null;
  },
};

export default translatePlugin;
