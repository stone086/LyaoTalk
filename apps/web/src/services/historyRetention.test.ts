// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { getStoredHistoryRetentionDays, isMessageWithinRetention, setStoredHistoryRetentionDays } from "./historyRetention";

describe("history retention choices", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to one day and migrates removed choices", () => {
    expect(getStoredHistoryRetentionDays()).toBe(1);
    localStorage.setItem("liaot-history-retention-days", "0");
    expect(getStoredHistoryRetentionDays()).toBe(1);
    localStorage.setItem("liaot-history-retention-days", "30");
    expect(getStoredHistoryRetentionDays()).toBe(1);
  });

  it("keeps only one, three, or seven days", () => {
    setStoredHistoryRetentionDays(7);
    expect(getStoredHistoryRetentionDays()).toBe(7);
    setStoredHistoryRetentionDays(30);
    expect(getStoredHistoryRetentionDays()).toBe(1);
  });

  it("does not restore server archive messages beyond the selected period", () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    expect(isMessageWithinRetention(now - 23 * 60 * 60 * 1000, now)).toBe(true);
    expect(isMessageWithinRetention(now - 25 * 60 * 60 * 1000, now)).toBe(false);
    setStoredHistoryRetentionDays(3);
    expect(isMessageWithinRetention(now - 2 * 24 * 60 * 60 * 1000, now)).toBe(true);
  });
});
