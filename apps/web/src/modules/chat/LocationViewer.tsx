import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useLanguage } from "@/utils/i18n";
import { mapNavigationUrls } from "@/utils/mapNavigation";

export default function LocationViewer({ latitude, longitude, onClose }: {
  latitude: number;
  longitude: number;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);
  const [showNavigation, setShowNavigation] = useState(false);
  const navigationUrls = mapNavigationUrls(latitude, longitude, /iPad|iPhone|iPod/i.test(navigator.userAgent));

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current).setView([latitude, longitude], 16);
    L.tileLayer("/map/tiles/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).on("tileerror", () => setTilesUnavailable(true)).addTo(map);
    L.circleMarker([latitude, longitude], {
      radius: 9,
      color: "#ffffff",
      weight: 2,
      fillColor: "#635bdf",
      fillOpacity: 1,
    }).addTo(map);
    return () => { map.remove(); };
  }, [latitude, longitude]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={t("chat.location")}>
      <div className="popover-surface flex max-h-[96vh] w-full max-w-3xl flex-col gap-3 rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">{t("chat.location")}</h2>
          <button type="button" className="btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
        </div>
        <div ref={containerRef} className="h-[50vh] min-h-[280px] max-h-[520px] w-full overflow-hidden rounded-xl" aria-label={t("chat.locationMap")} />
        <p className="text-xs text-surface-200/70">{latitude.toFixed(6)}, {longitude.toFixed(6)}</p>
        <button type="button" className="btn-primary self-start" onClick={() => setShowNavigation((open) => !open)} aria-expanded={showNavigation}>
          {t("chat.shareToMaps")}
        </button>
        {showNavigation && <div className="flex flex-wrap gap-2">
          <a className="btn-ghost border-default" href={navigationUrls.amap}>{t("chat.navigateAmap")}</a>
          <a className="btn-ghost border-default" href={navigationUrls.baidu}>{t("chat.navigateBaidu")}</a>
        </div>}
        {tilesUnavailable && <p className="text-xs text-warn">{t("chat.mapTilesUnavailable")}</p>}
      </div>
    </div>
  );
}
