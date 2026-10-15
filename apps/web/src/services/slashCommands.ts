/**
 * slashCommands.ts - Built-in slash commands for the chat composer.
 *
 * Type "/" in the input field to see suggestions.
 * Each command is processed locally before any XMPP send.
 *
 * Built-in commands:
 *   /me <action>      - send /me action message (XMPP relayed style)
 *   /clear            - clear local message cache for this conversation
 *   /shrug            - insert ¯\_(ツ)_/¯
 *   /tableflip        - insert (╯°□°)╯︵ ┻━┻
 *   /翻译 <text>      - translate text via AI
 *   /提醒 <Nm/Nh> <text> - schedule a local reminder
 *   /summary          - request AI summary of this conversation
 *   /ai <prompt>      - direct AI assistant query (only this user sees reply)
 *   /help             - show command list
 *
 * Plugins can register additional commands via the plugin SDK.
 */

import toast from "react-hot-toast";
import { aiApi, getUserToken } from "./api";

export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string, context: SlashContext) => Promise<string | null>;
  /** if true, the original "/cmd" is NOT sent as a message - the handler return is */
  consume: boolean;
}

export interface SlashContext {
  conversationId: string;
  accountId: string;
  insertText: (text: string) => void;
  showSystemMessage: (body: string) => void;
}

const commands: Map<string, SlashCommand> = new Map();

export function registerSlashCommand(cmd: SlashCommand) {
  commands.set(cmd.name, cmd);
}

export function getAllSlashCommands(): SlashCommand[] {
  return Array.from(commands.values());
}

/**
 * Parse a composer input. If it's a slash command, run it.
 * Returns:
 *   { handled: true, replacement: "..." }   - replace original text with this
 *   { handled: true, replacement: null }    - command absorbed (don't send)
 *   { handled: false }                       - not a command, send as-is
 */
export async function processSlashCommand(
  input: string,
  context: SlashContext
): Promise<{ handled: boolean; replacement?: string | null }> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { handled: false };

  const space = trimmed.indexOf(" ");
  const cmdName = space > 0 ? trimmed.slice(1, space) : trimmed.slice(1);
  const args = space > 0 ? trimmed.slice(space + 1) : "";

  const cmd = commands.get(cmdName);
  if (!cmd) return { handled: false };

  try {
    const result = await cmd.handler(args, context);
    if (cmd.consume) {
      return { handled: true, replacement: null };
    }
    return { handled: true, replacement: result ?? input };
  } catch (e: any) {
    toast.error(`/${cmdName}: ${e?.message ?? "failed"}`);
    return { handled: true, replacement: null };
  }
}

// =====================================================
// Built-in commands
// =====================================================

registerSlashCommand({
  name: "me",
  description: "Send action message (e.g. /me waves)",
  consume: false,
  handler: async (args) => `/me ${args}`,
});

registerSlashCommand({
  name: "shrug",
  description: "Insert ¯\\_(ツ)_/¯",
  consume: false,
  handler: async (args) => `${args}¯\\_(ツ)_/¯`.trim(),
});

registerSlashCommand({
  name: "tableflip",
  description: "Insert (╯°□°)╯︵ ┻━┻",
  consume: false,
  handler: async (args) => `${args}(╯°□°)╯︵ ┻━┻`.trim(),
});

registerSlashCommand({
  name: "翻译",
  description: "Translate text via AI",
  consume: false,
  handler: async (args) => {
    if (!args) throw new Error("Provide text to translate");
    const r = await aiApi.translate(args);
    return r.translated;
  },
});

registerSlashCommand({
  name: "translate",
  description: "Translate text via AI",
  consume: false,
  handler: async (args) => {
    if (!args) throw new Error("Provide text to translate");
    const r = await aiApi.translate(args);
    return r.translated;
  },
});

registerSlashCommand({
  name: "ai",
  description: "Ask the AI assistant (only you see the reply)",
  consume: true,
  handler: async (args, ctx) => {
    if (!args) throw new Error("Provide a prompt");
    try {
      const resp = await fetch("/api/ai/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: args,
          conversation_id: ctx.conversationId,
          persona: "concise",
        }),
      });
      const data = await resp.json();
      ctx.showSystemMessage(`🤖 ${data.reply}`);
    } catch {
      ctx.showSystemMessage("AI unavailable");
    }
    return null;
  },
});

registerSlashCommand({
  name: "help",
  description: "Show available commands",
  consume: true,
  handler: async (_args, ctx) => {
    const list = getAllSlashCommands()
      .map(c => `/${c.name} — ${c.description}`)
      .join("\n");
    ctx.showSystemMessage(`Available commands:\n${list}`);
    return null;
  },
});

registerSlashCommand({
  name: "summary",
  description: "Generate AI summary of this conversation",
  consume: true,
  handler: async (_args, ctx) => {
    try {
      const resp = await fetch("/api/ai/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [], conversation_id: ctx.conversationId }),
      });
      const data = await resp.json();
      ctx.showSystemMessage(`📝 Summary: ${data.summary}`);
    } catch {
      ctx.showSystemMessage("Summary unavailable");
    }
    return null;
  },
});
