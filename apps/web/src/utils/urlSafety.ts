/**
 * urlSafety.ts — Reject URLs whose scheme can execute code in the browser
 * when placed in `<a href>` or `<img src>` attributes.
 *
 * THE ATTACK
 * Stored XSS via peer-controlled data (XMPP roster avatarUrl from PEP/vCard,
 * link-preview og:image, attachment download URLs forwarded from peer
 * servers). Any of these could carry:
 *   - `javascript:alert(1)` — executes when clicked in a link
 *   - `data:image/svg+xml,<svg onload="...">` — SVG event handlers DO fire
 *     in <img src="data:..."> on every modern browser. This is the highest-
 *     risk variant because no user interaction is required: opening the
 *     conversation triggers the payload.
 *   - `vbscript:` — legacy IE/Edge, still worth rejecting
 *   - `file://` — local file disclosure on broken native wrappers
 *
 * THE FIX
 * Whitelist schemes for the surface they're used in:
 *   - `safeHref`: http, https, mailto, tel, xmpp (clickable links only)
 *   - `safeImageSrc`: http, https, blob:, data:image/{png,jpeg,gif,webp}
 *     (data: allowed only for raster image MIME types, never SVG)
 *
 * Anything else returns null and the caller falls back to a placeholder.
 */

const HREF_ALLOWED = /^(https?:|mailto:|tel:|xmpp:)/i;
// blob: URLs are created in-memory by us (e.g., decrypted aesgcm media);
// data: is restricted to raster image MIME types only — SVG specifically is
// EXCLUDED because SVG can carry executable script.
const IMAGE_SRC_ALLOWED = /^(https?:|blob:)/i;
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|x-icon|vnd\.microsoft\.icon)[;,]/i;

/**
 * Sanitize a URL intended for `<a href>`. Returns the URL if safe, or null
 * if the scheme would allow code execution. Caller should hide the link
 * entirely when null (don't fall back to "#" — that's a footgun in some
 * routers).
 */
export function safeHref(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Reject obvious injection attempts: control characters in URLs are valid
  // (technically allowed in fragments) but more often an attacker trying to
  // bypass scheme detection by interleaving newlines.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (HREF_ALLOWED.test(trimmed)) return trimmed;
  return null;
}

/**
 * Sanitize a URL intended for `<img src>`. Stricter than safeHref because
 * a user must click a link to trigger href-based XSS, but image sources
 * load automatically — passive XSS surface.
 */
export function safeImageSrc(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (IMAGE_SRC_ALLOWED.test(trimmed)) return trimmed;
  // Allow data: URLs only for raster image MIME types (never SVG which can
  // contain script). The MIME type comes from the URL itself but we still
  // catch the highest-risk cases.
  if (SAFE_DATA_IMAGE.test(trimmed)) return trimmed;
  return null;
}
