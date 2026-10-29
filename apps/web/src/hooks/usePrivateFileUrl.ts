import { useEffect, useState } from "react";
import { privateFileBlob, type TransferDetails } from "@/services/api";
import { isTrustedFilesUrl } from "@/services/trustedFilesUrl";

/** Resolve a private file to a local blob URL without putting a JWT in the URL. */
export function usePrivateFileUrl(rawUrl: string, accountId?: string | null): { url: string | null; progress: number | null; details?: TransferDetails } {
  const key = `${accountId ?? ""}\n${rawUrl}`;
  const [resolved, setResolved] = useState<{ key: string; url: string | null }>({ key, url: null });
  const [download, setDownload] = useState<{ key: string; progress: number | null; details?: TransferDetails }>({ key, progress: null });

  useEffect(() => {
    if (!isTrustedFilesUrl(rawUrl, window.location.origin)) {
      try {
        const external = new URL(rawUrl, window.location.origin);
        setResolved({ key, url: ["https:", "http:"].includes(external.protocol) ? external.href : null });
      } catch {
        setResolved({ key, url: null });
      }
      return;
    }
    setResolved({ key, url: null });
    setDownload({ key, progress: 0 });
    if (!accountId) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    privateFileBlob(rawUrl, accountId, controller.signal, (progress, details) => {
      if (!cancelled) setDownload({ key, progress, details });
    })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setResolved({ key, url: objectUrl });
      })
      .catch(() => {
        if (!cancelled) {
          setResolved({ key, url: null });
          setDownload({ key, progress: null });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [rawUrl, accountId, key]);

  return {
    url: resolved.key === key ? resolved.url : null,
    progress: download.key === key ? download.progress : null,
    details: download.key === key ? download.details : undefined,
  };
}
