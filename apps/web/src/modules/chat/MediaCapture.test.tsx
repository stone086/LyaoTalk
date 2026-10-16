import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/i18n", () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
import MediaCapture from "./MediaCapture";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stopVideo = vi.fn();
const stopAudio = vi.fn();
const videoStream = { getTracks: () => [{ stop: stopVideo }], getVideoTracks: () => [{ stop: stopVideo }] };
const audioStream = { getTracks: () => [{ stop: stopAudio }], getAudioTracks: () => [{ stop: stopAudio }] };
const getUserMedia = vi.fn(async (options: MediaStreamConstraints) => options.audio ? audioStream : videoStream);

class FakeRecorder {
  static isTypeSupported = () => true;
  mimeType = "video/webm";
  state: RecordingState = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["video"], { type: "video/webm" }) });
    this.onstop?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
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

describe("combined camera shutter", () => {
  async function mount(onCaptured: (file: File) => void) {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const root = createRoot(element);
    await act(async () => { root.render(<MediaCapture onCaptured={onCaptured} onFallback={vi.fn()} onClose={vi.fn()} />); await Promise.resolve(); });
    const shutter = element.querySelector('button[aria-label="chat.captureHint"]') as HTMLButtonElement;
    expect(shutter).toBeTruthy();
    return { element, root, shutter };
  }

  it("captures a photo on a short press", async () => {
    const captured = vi.fn();
    const { element, root, shutter } = await mount(captured);
    await act(async () => {
      shutter.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      vi.advanceTimersByTime(100);
      shutter.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(captured).toHaveBeenCalledWith(expect.objectContaining({ type: "image/jpeg" }));
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
    await act(async () => root.unmount());
    element.remove();
  });

  it("records video on a long press and stops on release", async () => {
    const captured = vi.fn();
    const { element, root, shutter } = await mount(captured);
    await act(async () => {
      shutter.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => shutter.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    expect(captured).toHaveBeenCalledWith(expect.objectContaining({ type: "video/webm" }));
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    await act(async () => root.unmount());
    element.remove();
  });
});
