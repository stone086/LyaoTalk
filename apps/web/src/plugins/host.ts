import { pluginsApi } from "@/services/api";
import type { ChatToolbarAction, ChatToolbarContext, ConjiPlugin } from "@/plugins/sdk";
import { aiSummaryPlugin } from "@/plugins/builtins/aiSummaryPlugin";

const BUILTIN_PLUGINS: Record<string, ConjiPlugin> = {
  "ai-summary": aiSummaryPlugin,
};

export async function getEnabledPluginIds(): Promise<string[]> {
  try {
    const list = await pluginsApi.list();
    if (!Array.isArray(list)) return [];
    return list
      .filter((p: any) => p?.is_enabled)
      .map((p: any) => String(p.id))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function getChatToolbarActions(ctx: ChatToolbarContext): Promise<ChatToolbarAction[]> {
  const enabledIds = await getEnabledPluginIds();
  const actions: ChatToolbarAction[] = [];

  enabledIds.forEach((id) => {
    const plugin = BUILTIN_PLUGINS[id];
    if (!plugin?.getChatToolbarActions) return;
    actions.push(...plugin.getChatToolbarActions(ctx));
  });

  return actions;
}
