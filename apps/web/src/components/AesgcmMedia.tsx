/**
 * AesgcmMedia.tsx — Render an aesgcm:// URL as inline audio/image/file.
 *
 * On mount: fetches the encrypted blob, decrypts via WebCrypto, exposes a blob: URL.
 * On unmount: revokes the blob URL.
 * On error: shows a fallback "encrypted attachment" link.
 */
import { useEffect, useState } from "react";
import { Loader2, AlertCircle, Download } from "lucide-react";
import { fetchAndDecryptAesgcm } from "@/services/aesgcmMedia";
import { useAccountStore } from "@/stores/accountStore";
import { safeHref } from "@/utils/urlSafety";
import { useLanguage } from "@/utils/i18n";

interface AesgcmMediaProps {
  /** The full aesgcm:// URL including the #hex fragment */
  url: string;
  /** Best-guess filename (used to pick image/audio/video/file rendering) */
  fileName: string;
  /** Optional plain HTTPS URL of the same resource — shown as a fallback link */
  plainHref?: string;
}

type Status =
  | { kind: "loading" }
  | { kind: "ready"; blobUrl: string }
  | { kind: "error"; message: string; authFailure: boolean };

function pickKind(name: string): "image" | "audio" | "video" | "file" {
  const lower = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|heic|heif|bmp)$/.test(lower)) return "image";
  if (/\.(m4a|mp3|ogg|oga|opus|wav|webm)$/.test(lower)) return "audio";
  if (/\.(mp4|mov|webm|mkv)$/.test(lower)) return "video";
  return "file";
}

export default function AesgcmMedia({ url, fileName, plainHref }: AesgcmMediaProps) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const { t } = useLanguage();

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setStatus({ kind: "loading" });

    fetchAndDecryptAesgcm(url, { signal: ctrl.signal, accountId: activeAccountId })
      .then((blobUrl) => {
        if (!cancelled) setStatus({ kind: "ready", blobUrl });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        const authFailure = (err as { response?: { status?: number } })?.response?.status === 401;
        setStatus({ kind: "error", message, authFailure });
      });

    return () => {
      cancelled = true;
      ctrl.abort();
      // Note: don't revoke the cached URL here — other messages may share it.
      // The cache lives until logout / page unload, or explicit cleanup.
    };
  }, [url, activeAccountId, retryCount]);

  const kind = pickKind(fileName);

  if (status.kind === "loading") {
    return (
      <div className="flex items-center gap-2 text-xs text-surface-200/70 py-2">
        <Loader2 size={14} className="animate-spin" />
        <span>{t("media.decrypting", { fileName })}</span>
      </div>
    );
  }

  if (status.kind === "error") {
    return (
      <div className="flex flex-col gap-1 py-1">
        <div className="flex items-center gap-2 text-xs text-warn">
          <AlertCircle size={14} />
          <span>{status.authFailure ? t("media.downloadAuthFailed") : t("media.decryptFailed", { message: status.message })}</span>
        </div>
        <button type="button" onClick={() => setRetryCount((count) => count + 1)} className="w-fit text-xs text-accent-soft underline">{t("media.retry")}</button>
        {plainHref && safeHref(plainHref) && (
          <a
            href={safeHref(plainHref)!}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-accent-soft underline break-all"
          >
            <Download size={10} className="inline -mt-0.5 mr-1" />
            {t("media.rawFile", { fileName })}
          </a>
        )}
      </div>
    );
  }

  // Ready — render media inline
  if (kind === "image") {
    return (
      <>
        <button type="button" onClick={() => setPreviewOpen(true)} className="block max-w-xs cursor-zoom-in">
          <img src={status.blobUrl} alt={fileName} className="rounded-lg max-w-full max-h-64 object-contain" loading="lazy" />
        </button>
        {previewOpen && (
          <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={fileName} onClick={() => setPreviewOpen(false)} onContextMenu={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()}>
            <img src={status.blobUrl} alt={fileName} className="max-w-full max-h-full object-contain" onClick={(event) => event.stopPropagation()} />
            <button type="button" onClick={() => setPreviewOpen(false)} className="absolute top-4 right-4 rounded bg-black/60 px-3 py-1 text-white" aria-label="Close image preview">×</button>
          </div>
        )}
      </>
    );
  }

  if (kind === "audio") {
    return (
      <audio
        src={status.blobUrl}
        controls
        preload="metadata"
        className="max-w-full"
      >
        {t("media.audioUnsupported")}
      </audio>
    );
  }

  if (kind === "video") {
    return (
      <video
        src={status.blobUrl}
        controls
        preload="metadata"
        className="rounded-lg max-w-full max-h-64"
      >
        {t("media.videoUnsupported")}
      </video>
    );
  }

  // Generic file — download link
  return (
    <a
      href={status.blobUrl}
      download={fileName}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-800 text-sm text-accent-soft hover:bg-surface-800/80 transition-colors"
    >
      <Download size={14} />
      {fileName}
    </a>
  );
}
