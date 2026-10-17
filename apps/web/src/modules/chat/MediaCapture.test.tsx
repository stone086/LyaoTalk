import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/i18n", () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock("@/services/videoFormat", () => ({ videoRecordingToMp4: vi.fn(async () => new File(["mp4"], "video.mp4", { type: "video/mp4" })) }));
import MediaCapture from "./MediaCapture";
import { videoRecordingToMp4 } from "@/services/videoFormat";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stopVideo = vi.fn();
const stopAudio = vi.fn();
const videoStream = { getTracks: () => [{ stop: stopVideo }], getVideoTracks: () => [{ stop: stopVideo }] };
const audioStream = { getTracks: () => [{ stop: stopAudio }], getAudioTracks: () => [{ stop: stopAudio }] };
const getUserMedia = vi.fn(async (options: MediaStreamConstraints) => options.audio ? audioStream : videoStream);

class FakeRecorder {
  static isTypeSupported = vi.fn(() => true);
  static requestedMimeType = "";
  mimeType: string;
  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? "video/webm";
    FakeRecorder.requestedMimeType = this.mimeType;
  }
  state: RecordingState = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["video"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeRecorder.requestedMimeType = "";
  FakeRecorder.isTypeSupported.mockImplementation(() => true);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  Object.defineProperty(globalThis, "MediaStream", { configurable: true, value: class { constructor(public tracks: unknown[]) {} } });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
  Object.defineProperty(HTMLVideoElement.prototype, "play", { configurable: true, value: vi.fn(async () => {}) });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, value: 640 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, value: 480 });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => ({ drawImage: vi.fn() }) });
  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", { configurable: true, value: (callback: (blob: Blob) => void) => callback(new Blob(["photo"], { type: "image/jpeg" })) });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("camera controls", () => {
  async function mount(onCaptured: (file: File) => void) {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const root = createRoot(element);
    await act(async () => { root.render(<MediaCapture onCaptured={onCaptured} onFallback={vi.fn()} onClose={vi.fn()} />); await Promise.resolve(); });
    const shutter = element.querySelector('button[aria-label="chat.captureHint"]') as HTMLButtonElement;
    expect(shutter).toBeTruthy();
    return { element, root, shutter };
  }

  it("captures a photo when the shutter is tapped", async () => {
    const captured = vi.fn();
    const { element, root, shutter } = await mount(captured);
    await act(async () => {
      shutter.click();
    });
    expect(captured).toHaveBeenCalledWith(expect.objectContaining({ type: "image/jpeg" }));
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
    await act(async () => root.unmount());
    element.remove();
  });

  it("records video only through the separate video button", async () => {
    const captured = vi.fn();
    const { element, root, shutter } = await mount(captured);
    const videoButton = element.querySelector('button[aria-label="chat.recordVideo"]') as HTMLButtonElement;
    await act(async () => {
      videoButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(shutter.getAttribute("aria-label")).toBe("chat.captureHint");
    await act(async () => { (element.querySelector('button[aria-label="chat.stopVideo"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(FakeRecorder.requestedMimeType).toBe("video/mp4;codecs=avc1.42E01E,mp4a.40.2");
    expect(captured).toHaveBeenCalledWith(expect.objectContaining({ type: "video/mp4", name: "video.mp4" }));
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    await act(async () => root.unmount());
    element.remove();
  });

  it("converts a WebM-only browser recording before sending", async () => {
    FakeRecorder.isTypeSupported.mockImplementation((mimeType: string) => mimeType.startsWith("video/webm"));
    const captured = vi.fn();
    const { element, root } = await mount(captured);
    await act(async () => {
      (element.querySelector('button[aria-label="chat.recordVideo"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(FakeRecorder.requestedMimeType).toBe("video/webm;codecs=vp8,opus");
    await act(async () => { (element.querySelector('button[aria-label="chat.stopVideo"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(videoRecordingToMp4).toHaveBeenCalledWith(expect.objectContaining({ type: "video/webm;codecs=vp8,opus" }));
    expect(captured).toHaveBeenCalledWith(expect.objectContaining({ type: "video/mp4" }));
    await act(async () => root.unmount());
    element.remove();
  });
});
