/**
 * LiaoT Plugin SDK
 * Use this to build plugins that extend the client.
 */

export type PluginEvent =
  | "message.received"
  | "message.sent"
  | "conversation.opened"
  | "conversation.closed"
  | "roster.updated"
  | "presence.updated"
  | "room.joined"
  | "room.left";

export interface PluginContext {
  /** Plugin's own ID */
  pluginId: string;
  /** Call the backend API */
  callApi: (path: string, options?: RequestInit) => Promise<unknown>;
  /** Get current active conversation ID */
  getCurrentConversationId: () => string | null;
  /** Get plugin config from backend */
  getConfig: () => Promise<Record<string, unknown>>;
  /** Save plugin config to backend */
  saveConfig: (config: Record<string, unknown>) => Promise<void>;
  /** Listen to XMPP events */
  onEvent: (event: PluginEvent, handler: (data: unknown) => void) => () => void;
  /** Show a toast notification */
  notify: (message: string, type?: "success" | "error" | "info") => void;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions: string[];
  /** Injection points this plugin occupies */
  slots: PluginSlot[];
}

export type PluginSlot =
  | "message.render.before"
  | "message.render.after"
  | "chat.toolbar"
  | "conversation.sidebar"
  | "settings.panel"
  | "command.palette"
  | "account.menu"
  | "global.search.extension";

export interface Plugin {
  manifest: PluginManifest;
  /** Called once when plugin is initialized */
  init: (ctx: PluginContext) => void | Promise<void>;
  /** Called when plugin is disabled/unloaded */
  destroy?: () => void | Promise<void>;
  /** Render function for UI slots */
  render?: (slot: PluginSlot, props: unknown) => unknown;
}

/** Plugin registry - plugins register themselves here */
export const pluginRegistry: Map<string, Plugin> = new Map();

export function registerPlugin(plugin: Plugin) {
  pluginRegistry.set(plugin.manifest.id, plugin);
  console.log(`[PluginSDK] Registered: ${plugin.manifest.id} v${plugin.manifest.version}`);
}
