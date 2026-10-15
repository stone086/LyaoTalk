import { useEffect, useState } from "react";
import { privateFileBlob } from "@/services/api";
import { isTrustedFilesUrl } from "@/services/trustedFilesUrl";

/** Resolve a private file to a local blob URL without putting a JWT in the URL. */
export function usePrivateFileUrl(rawUrl: string, accountId?: string | null): string | null {
  const key = `${accountId ?? ""}\n${rawUrl}`;
  const [resolved, setResolved] = useState<{ key: string; url: string | null }>({ key, url: null });

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
    if (!accountId) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    privateFileBlob(rawUrl, accountId, controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setResolved({ key, url: objectUrl });
      })
      .catch(() => {
        if (!cancelled) setResolved({ key, url: null });
      });
    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [rawUrl, accountId, key]);

  return resolved.key === key ? resolved.url : null;
}
