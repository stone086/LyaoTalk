import { describe, expect, it } from "vitest";
import { chatPath, chatRouteId, resolveChatRouteId } from "./chatRoute";

describe("chat routes", () => {
  const id = "a3c38d99-8058-42ad-841b-7ce29416ca27:资料库@conference.2-yc.com";
  const conversations = { [id]: { id } };

  it("hides the group name and JID in a stable route", () => {
    const path = chatPath(id);
    expect(path).toMatch(/^\/chat\/[0-9a-f]{32}$/);
    expect(path).not.toContain("资料库");
    expect(path).not.toContain("conference");
    expect(chatRouteId(id)).toBe(chatRouteId(id));
  });

  it("resolves new routes and old bookmarks", () => {
    expect(resolveChatRouteId(chatRouteId(id), conversations)).toBe(id);
    expect(resolveChatRouteId(id, conversations)).toBe(id);
    expect(resolveChatRouteId("missing", conversations)).toBeNull();
  });
});
