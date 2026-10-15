import { describe, expect, it } from "vitest";
import { isTrustedFilesUrl, trustedFileObjectKey } from "./trustedFilesUrl";

const origin = "https://liaot.example.org";

describe("trusted file URLs", () => {
  it("accepts only the app and its upload subdomain", () => {
    expect(isTrustedFilesUrl("/files/uploads/a.png", origin)).toBe(true);
    expect(isTrustedFilesUrl("https://upload.liaot.example.org/files/uploads/a.png", origin)).toBe(true);
    expect(isTrustedFilesUrl("https://evil.example/files/uploads/a.png", origin)).toBe(false);
    expect(isTrustedFilesUrl("https://upload.liaot.example.org.evil.example/files/a", origin)).toBe(false);
    expect(isTrustedFilesUrl("//evil.example/files/a", origin)).toBe(false);
    expect(isTrustedFilesUrl("https://upload.liaot.example.org/other/a", origin)).toBe(false);
  });

  it("extracts only trusted file keys without carrying URL query credentials", () => {
    const origin = "https://liaot.example.org";
    expect(trustedFileObjectKey("https://upload.liaot.example.org/files/uploads/a.png?t=old-token", origin)).toBe("uploads/a.png");
    expect(trustedFileObjectKey("https://evil.example/files/uploads/a.png", origin)).toBeNull();
    expect(trustedFileObjectKey("/files/../admin", origin)).toBeNull();
  });
});
