import { describe, expect, it } from "vitest";
import { isTrustedFilesUrl, isTrustedXmppUploadUrl, trustedFileObjectKey } from "./trustedFilesUrl";

const origin = "https://lyaot.2-yc.com";

describe("trusted file URLs", () => {
  it("accepts only the app and its upload subdomain", () => {
    expect(isTrustedFilesUrl("/files/uploads/a.png", origin)).toBe(true);
    expect(isTrustedFilesUrl("https://upload.lyaot.2-yc.com/files/uploads/a.png", origin)).toBe(true);
    expect(isTrustedFilesUrl("https://evil.example/files/uploads/a.png", origin)).toBe(false);
    expect(isTrustedFilesUrl("https://upload.lyaot.2-yc.com.evil.example/files/a", origin)).toBe(false);
    expect(isTrustedFilesUrl("//evil.example/files/a", origin)).toBe(false);
    expect(isTrustedFilesUrl("https://upload.lyaot.2-yc.com/other/a", origin)).toBe(false);
  });

  it("extracts only trusted file keys without carrying URL query credentials", () => {
    const origin = "https://lyaot.2-yc.com";
    expect(trustedFileObjectKey("https://upload.lyaot.2-yc.com/files/uploads/a.png?t=old-token", origin)).toBe("uploads/a.png");
    expect(trustedFileObjectKey("https://evil.example/files/uploads/a.png", origin)).toBeNull();
    expect(trustedFileObjectKey("/files/../admin", origin)).toBeNull();
  });

  it("recognizes only this server's public XMPP upload links", () => {
    expect(isTrustedXmppUploadUrl("https://upload.lyaot.2-yc.com/upload/abc/photo.jpg", origin)).toBe(true);
    expect(isTrustedXmppUploadUrl("https://upload.lyaot.2-yc.com/files/abc/photo.jpg", origin)).toBe(false);
    expect(isTrustedXmppUploadUrl("https://upload.lyaot.2-yc.com.evil.test/upload/a.jpg", origin)).toBe(false);
    expect(isTrustedXmppUploadUrl("http://upload.lyaot.2-yc.com/upload/a.jpg", origin)).toBe(false);
  });
});
