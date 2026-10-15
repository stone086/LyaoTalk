import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useLanguage } from "@/utils/i18n";

interface LocationPickerProps {
  onSelect: (latitude: number, longitude: number) => void;
  onSearch: (query: string) => void;
  onClose: () => void;
}

export default function LocationPicker({ onSelect, onSearch, onClose }: LocationPickerProps) {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const locateRef = useRef<() => void>(() => {});
  const [selected, setSelected] = useState<L.LatLng | null>(null);
  const [query, setQuery] = useState("");
  const [locating, setLocating] = useState(false);
  const [locationUnavailable, setLocationUnavailable] = useState(false);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    const map = L.map(containerRef.current).setView([35, 105], 4);
    mapRef.current = map;
    L.tileLayer("/map/tiles/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).on("tileerror", () => setTilesUnavailable(true)).addTo(map);
    map.on("click", (event: L.LeafletMouseEvent) => setSelected(event.latlng));

    locateRef.current = () => {
      if (!navigator.geolocation) {
        setLocationUnavailable(true);
        return;
      }
      setLocating(true);
      setLocationUnavailable(false);
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
          if (cancelled) return;
          const point = L.latLng(coords.latitude, coords.longitude);
          setSelected(point);
          map.setView(point, 15);
          setLocating(false);
        },
        () => {
          if (cancelled) return;
          setLocationUnavailable(true);
          setLocating(false);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
      );
    };
    locateRef.current();
    return () => {
      cancelled = true;
      locateRef.current = () => {};
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!selected) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (markerRef.current) markerRef.current.setLatLng(selected);
    else markerRef.current = L.circleMarker(selected, {
      radius: 9,
      color: "#ffffff",
      weight: 2,
      fillColor: "#635bdf",
      fillOpacity: 1,
    }).addTo(map);
  }, [selected]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={t("chat.location")}>
      <div className="popover-surface flex max-h-[96vh] w-full max-w-3xl flex-col gap-3 overflow-y-auto rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">{t("chat.location")}</h2>
          <button type="button" className="btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
        </div>
        <div ref={containerRef} className="h-[50vh] min-h-[280px] max-h-[520px] w-full overflow-hidden rounded-xl" aria-label={t("chat.locationMap")} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-surface-200/80">
          <span>{selected ? `${selected.lat.toFixed(6)}, ${selected.lng.toFixed(6)}` : t("chat.tapMapToChoose")}</span>
          <button type="button" className="btn-ghost" disabled={locating} onClick={() => locateRef.current()}>{locating ? t("chat.locating") : t("chat.locateMe")}</button>
        </div>
        {locationUnavailable && <p className="text-xs text-warn">{t("chat.locationUnavailableMap")}</p>}
        {tilesUnavailable && <p className="text-xs text-warn">{t("chat.mapTilesUnavailable")}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-primary" disabled={!selected} onClick={() => selected && onSelect(selected.lat, selected.lng)}>{t("chat.shareSelectedLocation")}</button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); if (query.trim()) onSearch(query.trim()); }} className="flex gap-2 border-t border-subtle pt-3">
          <input className="input-field min-w-0 flex-1" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("chat.locationName")} maxLength={200} />
          <button type="submit" className="btn-ghost border-default" disabled={!query.trim()}>{t("chat.sharePlaceSearch")}</button>
        </form>
      </div>
    </div>
  );
}
