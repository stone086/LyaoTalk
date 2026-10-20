// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeImageSrc } from "./urlSafety";

afterEach(() => vi.unstubAllGlobals());

describe("avatar image sources under the site's CSP", () => {
  it("converts raster data images to a reusable blob URL", () => {
    const createObjectURL = vi.fn(() => "blob:https://lyaot.2-yc.com/avatar-test");
    vi.stubGlobal("URL", { createObjectURL });
    const source = "data:image/jpeg;base64,YWJj";
    expect(safeImageSrc(source)).toBe("blob:https://lyaot.2-yc.com/avatar-test");
    expect(safeImageSrc(source)).toBe("blob:https://lyaot.2-yc.com/avatar-test");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(safeImageSrc("data:image/svg+xml;base64,YWJj")).toBeNull();
  });
});
