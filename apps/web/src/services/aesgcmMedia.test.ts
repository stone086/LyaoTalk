// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Blob } from "node:buffer";
import { decryptedMediaType, encryptForAesgcm, parseAesgcmUrl, toAesgcmUrl } from "./aesgcmMedia";

describe("federated AES-GCM media link", () => {
  it("restores the image MIME type after decrypting an octet-stream upload", () => {
    expect(decryptedMediaType("image.png")).toBe("image/png");
    expect(decryptedMediaType("photo.jpg?expires=123")).toBe("image/jpeg");
    expect(decryptedMediaType("unknown.bin")).toBe("application/octet-stream");
  });
  it("marks voice WebM as audio so clients do not show it as video", () => {
    expect(decryptedMediaType("voice-123.weba")).toBe("audio/webm");
    expect(decryptedMediaType("clip.webm")).toBe("video/webm");
  });
  it("puts the IV and key in a URL fragment that recipients can parse", async () => {
    const { fragment } = await encryptForAesgcm(new Blob(["test image"]) as globalThis.Blob);
    expect(fragment).toMatch(/^#[0-9a-f]{88}$/);
    const parsed = parseAesgcmUrl(`aesgcm://upload.example/image.png${fragment}`);
    expect(parsed?.ciphertextUrl).toBe("https://upload.example/image.png");
    expect(parsed?.iv).toHaveLength(12);
    expect(parsed?.key).toHaveLength(32);
  });

  it("reads old delivered links missing the separator without including the key in the download URL", () => {
    const hex = "a".repeat(88);
    const parsed = parseAesgcmUrl(`aesgcm://upload.lyaot.2-yc.com/file.png${hex}`);
    expect(parsed?.ciphertextUrl).toBe("https://upload.lyaot.2-yc.com/file.png");
    expect(parsed?.fileName).toBe("file.png");
    expect(parsed?.key).toHaveLength(32);
  });

  it("keeps signed URL parameters separate from the key fragment", () => {
    const fragment = `#${"a".repeat(88)}`;
    const link = toAesgcmUrl("https://lyaotalk.example/media/image.png?expires=123&sig=abc", fragment);
    expect(link).toBe(`aesgcm://lyaotalk.example/media/image.png?expires=123&sig=abc${fragment}`);
    expect(parseAesgcmUrl(link)?.ciphertextUrl).toBe("https://lyaotalk.example/media/image.png?expires=123&sig=abc");
    expect(() => toAesgcmUrl("http://lyaotalk.example/file", fragment)).toThrow();
    expect(() => toAesgcmUrl("https://lyaotalk.example/file", "a".repeat(88))).toThrow();
  });
});
