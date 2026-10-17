// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { voiceRecordingToM4a } from "./voiceFormat";

describe("voice message format", () => {
  it("keeps a native AAC-LC MP4 recording as an M4A file", async () => {
    const recording = new Blob(["native-aac"], { type: "audio/mp4" });
    const file = await voiceRecordingToM4a(recording, "audio/mp4;codecs=mp4a.40.2");
    expect(file.name).toMatch(/\.m4a$/);
    expect(file.type).toBe("audio/mp4");
    expect(file.size).toBe(recording.size);
  });

  it("does not send an empty recording", async () => {
    await expect(voiceRecordingToM4a(new Blob([]), "audio/webm")).rejects.toThrow("Recording is empty");
  });
});
