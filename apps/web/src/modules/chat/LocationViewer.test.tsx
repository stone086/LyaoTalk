import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/i18n", () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("leaflet", () => ({
  map: () => ({ setView() { return this; }, remove() {} }),
  tileLayer: () => ({ on() { return this; }, addTo() { return this; } }),
  circleMarker: () => ({ addTo() { return this; } }),
}));

import LocationViewer from "./LocationViewer";
import toast from "react-hot-toast";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sharing a received location", () => {
  async function mount() {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const root = createRoot(element);
    await act(async () => root.render(<LocationViewer latitude={29.794495} longitude={121.572255} onClose={vi.fn()} />));
    const button = Array.from(element.querySelectorAll("button")).find((item) => item.textContent === "chat.shareToMaps");
    expect(button).toBeTruthy();
    expect(element.querySelectorAll("a")).toHaveLength(0);
    return { element, root, button: button! };
  }

  it("opens the native share sheet with a provider-neutral map URL", async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    const { element, root, button } = await mount();
    await act(async () => button.click());
    expect(share).toHaveBeenCalledWith({
      title: "chat.location",
      text: "geo:29.794495,121.572255",
      url: "https://www.openstreetmap.org/?mlat=29.794495&mlon=121.572255#map=16/29.794495/121.572255",
    });
    await act(async () => root.unmount());
    element.remove();
  });

  it("copies the map URL if native sharing is unavailable", async () => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { element, root, button } = await mount();
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("openstreetmap.org/?mlat=29.794495"));
    expect(toast).toHaveBeenCalledWith("chat.mapLinkCopied");
    await act(async () => root.unmount());
    element.remove();
  });
});
