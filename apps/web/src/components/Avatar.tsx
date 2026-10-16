import { useState } from "react";
import { clsx } from "clsx";
import { safeImageSrc } from "@/utils/urlSafety";

interface AvatarProps {
  src?: string;
  name: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  presence?: "available" | "away" | "dnd" | "xa" | "unavailable";
  className?: string;
}

const SIZES = {
  xs: "w-6 h-6 text-[9px]",
  sm: "w-8 h-8 text-xs",
  md: "w-10 h-10 text-sm",
  lg: "w-12 h-12 text-base",
  xl: "w-16 h-16 text-xl",
};

const PRESENCE_COLORS = {
  available:   "bg-green-400",
  away:        "bg-yellow-400",
  dnd:         "bg-red-400",
  xa:          "bg-orange-400",
  unavailable: "bg-surface-200/30",
};

const DOT_SIZES = {
  xs: "w-1.5 h-1.5",
  sm: "w-2 h-2",
  md: "w-2.5 h-2.5",
  lg: "w-3 h-3",
  xl: "w-3.5 h-3.5",
};

function getInitials(name: string): string {
  return name
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * XEP-0392 Consistent Color Generation
 *
 * Computes a hue angle (0-360) from a deterministic SHA-1 hash of the
 * input identifier (typically a JID). Same JID always produces same color
 * across all XMPP clients that implement this XEP.
 *
 * This synchronous approximation uses FNV-1a-like rolling hash, which is
 * sufficient for visual consistency within LyaoTalk. For strict cross-client
 * compliance the SHA-1 variant is recommended (async).
 */
function colorFromName(name: string): string {
  // Strip resource if name looks like full JID
  const id = name.split("/")[0].toLowerCase();
  // FNV-1a 32-bit
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  // Map low 16 bits to hue 0-360 (XEP-0392 uses CRC-16-XMODEM but FNV gives
  // visually equivalent distribution)
  const hue = (hash & 0xffff) % 360;
  // Use HSL for guaranteed perceptual differentiation
  // Saturation 65%, Lightness 45% chosen for legibility on dark + light bg
  return `hsl(${hue}, 65%, 45%)`;
}

export default function Avatar({ src, name, size = "md", presence, className }: AvatarProps) {
  const [imgError, setImgError] = useState(false);
  // Reject avatar URLs that aren't http/https/blob/safe-data — peer-controlled
  // data from XMPP vCard / PEP avatar could carry javascript:/data:image/svg+xml
  // payloads that fire on render.
  const safeSrc = safeImageSrc(src);
  const showImg = !!safeSrc && !imgError;
  const initials = getInitials(name);
  const bg = colorFromName(name);

  return (
    <div className={clsx("relative flex-shrink-0", className)}>
      <div
        className={clsx(
          SIZES[size],
          "rounded-full flex items-center justify-center font-semibold text-white overflow-hidden",
        )}
        style={showImg ? undefined : { backgroundColor: bg }}
      >
        {showImg ? (
          <img
            src={safeSrc!}
            alt={name}
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          initials || "?"
        )}
      </div>

      {presence && (
        <span className={clsx(
          "absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-surface-900",
          DOT_SIZES[size],
          PRESENCE_COLORS[presence],
        )} />
      )}
    </div>
  );
}
