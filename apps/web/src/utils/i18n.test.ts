import { describe, expect, it } from "vitest";
import { getMessagesForLanguage, formatMessage } from "./i18n";

function keysOf(lang: "en-US" | "zh-CN") {
  return Object.keys(getMessagesForLanguage(lang)).sort();
}

describe("i18n language packs", () => {
  it("keeps English and Simplified Chinese keys in sync", () => {
    expect(keysOf("zh-CN")).toEqual(keysOf("en-US"));
  });

  it("does not leave empty translations", () => {
    for (const lang of ["en-US", "zh-CN"] as const) {
      for (const [key, value] of Object.entries(getMessagesForLanguage(lang))) {
        expect(value.trim(), `${lang}:${key}`).not.toBe("");
      }
    }
  });

  it("formats placeholder values", () => {
    expect(formatMessage("Hello {name}", { name: "User" })).toBe("Hello User");
    expect(formatMessage("Keep {missing}", {})).toBe("Keep {missing}");
  });
});
