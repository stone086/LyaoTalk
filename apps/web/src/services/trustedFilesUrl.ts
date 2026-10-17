export function isTrustedFilesUrl(rawUrl: string, pageOrigin: string): boolean {
  try {
    const page = new URL(pageOrigin);
    const target = new URL(rawUrl, page);
    if (!target.pathname.startsWith("/files/")) return false;
    const upload = new URL(page.origin);
    upload.hostname = `upload.${page.hostname}`;
    return target.origin === page.origin || target.origin === upload.origin;
  } catch {
    return false;
  }
}

export function trustedFileObjectKey(rawUrl: string, pageOrigin: string): string | null {
  if (!isTrustedFilesUrl(rawUrl, pageOrigin)) return null;
  const path = new URL(rawUrl, pageOrigin).pathname.slice("/files/".length);
  return path && !path.includes("..") ? path : null;
}

/** Public XEP-0363 uploads served by this deployment's Prosody component. */
export function isTrustedXmppUploadUrl(rawUrl: string, pageOrigin: string): boolean {
  try {
    const page = new URL(pageOrigin);
    const target = new URL(rawUrl);
    return target.protocol === "https:"
      && target.hostname === `upload.${page.hostname}`
      && target.port === ""
      && target.pathname.startsWith("/upload/")
      && !target.pathname.split("/").includes("..");
  } catch {
    return false;
  }
}
