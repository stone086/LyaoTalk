/**
 * LinkPreviewCard.tsx - Renders an Open Graph card for a URL.
 *
 * Used inline in chat bubbles whenever a message contains a URL.
 * The preview is fetched lazily once and cached in memory + IndexedDB.
 */
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { safeHref, safeImageSrc } from "@/utils/urlSafety";
import { useLanguage } from "@/utils/i18n";

interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  site_name?: string;
  favicon?: string;
}

const cache = new Map<string, LinkPreview | null>();

export default function LinkPreviewCard({ url }: { url: string }) {
  const { t } = useLanguage();
  const [preview, setPreview] = useState<LinkPreview | null | "loading">(
    cache.has(url) ? cache.get(url)! : "loading"
  );

  useEffect(() => {
    if (cache.has(url)) {
      setPreview(cache.get(url) ?? null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`/preview?url=${encodeURIComponent(url)}`);
        if (!resp.ok) {
          if (!cancelled) {
            cache.set(url, null);
            setPreview(null);
          }
          return;
        }
        const data: LinkPreview = await resp.json();
        if (!cancelled) {
          cache.set(url, data);
          setPreview(data);
        }
      } catch {
        if (!cancelled) {
          cache.set(url, null);
          setPreview(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  if (preview === "loading") {
    return (
      <div className="mt-2 px-3 py-2 rounded-lg border-default inset-surface text-xs text-surface-200/40">
        {t("preview.loading")}
      </div>
    );
  }
  if (!preview || (!preview.title && !preview.description && !preview.image)) {
    return null;
  }

  // Defense in depth: even though the backend validates URLs in `_looks_safe`,
  // re-check at the render boundary so a server-side bug or future endpoint
  // change can't silently introduce a javascript:/data: XSS.
  const safePreviewHref = safeHref(preview.url);
  const safePreviewImage = safeImageSrc(preview.image);
  const safeFavicon = safeImageSrc(preview.favicon);

  if (!safePreviewHref) return null;

  return (
    <a
      href={safePreviewHref}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 flex flex-col rounded-lg border-default overflow-hidden hover-surface transition-colors"
    >
      {safePreviewImage && (
        <img
          src={safePreviewImage}
          alt=""
          loading="lazy"
          className="w-full max-h-48 object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      )}
      <div className="px-3 py-2 flex flex-col gap-1">
        {preview.site_name && (
          <p className="text-[10px] text-surface-200/50 uppercase tracking-wider flex items-center gap-1">
            {safeFavicon && (
              <img
                src={safeFavicon}
                alt=""
                className="w-3 h-3"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            )}
            {preview.site_name}
            <ExternalLink size={9} className="ml-auto" />
          </p>
        )}
        {preview.title && (
          <p className="text-sm font-medium text-surface-50 line-clamp-2">{preview.title}</p>
        )}
        {preview.description && (
          <p className="text-xs text-surface-200/60 line-clamp-2">{preview.description}</p>
        )}
      </div>
    </a>
  );
}

/**
 * Extracts the first http(s) URL from a string. Returns null if none.
 */
export function extractFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"]+/);
  return m ? m[0] : null;
}
