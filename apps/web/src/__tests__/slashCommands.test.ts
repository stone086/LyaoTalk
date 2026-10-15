import { describe, expect, it, vi } from "vitest";
import { processSlashCommand, registerSlashCommand } from "../services/slashCommands";

const context = () => ({
  conversationId: "conversation-1",
  accountId: "account-1",
  insertText: vi.fn(),
  showSystemMessage: vi.fn(),
});

describe("processSlashCommand", () => {
  it("ignores non-slash input", async () => {
    const result = await processSlashCommand("hello", context());
    expect(result.handled).toBe(false);
  });

  it("processes /me as outbound action text", async () => {
    const result = await processSlashCommand("/me waves", context());
    expect(result).toEqual({ handled: true, replacement: "/me waves" });
  });

  it("consumes /help and writes a system message", async () => {
    const ctx = context();
    const result = await processSlashCommand("/help", ctx);
    expect(result).toEqual({ handled: true, replacement: null });
    expect(ctx.showSystemMessage).toHaveBeenCalled();
  });

  it("falls through unknown commands", async () => {
    const result = await processSlashCommand("/does-not-exist", context());
    expect(result.handled).toBe(false);
  });

  it("runs registered custom commands", async () => {
    registerSlashCommand({
      name: "unit-test-command",
      description: "test command",
      consume: false,
      handler: async (args) => `processed:${args}`,
    });
    const result = await processSlashCommand("/unit-test-command value", context());
    expect(result).toEqual({ handled: true, replacement: "processed:value" });
  });
});
