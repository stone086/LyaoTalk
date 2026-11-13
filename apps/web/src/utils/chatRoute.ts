// Keep internal conversation IDs (which contain JIDs and room names) out of URLs.
// Two independent 64-bit hashes make the route stable across devices and reloads.
export function chatRouteId(conversationId: string): string {
  const bytes = new TextEncoder().encode(conversationId);
  const mask = (1n << 64n) - 1n;
  const hash = (seed: bigint) => {
    let value = seed;
    for (const byte of bytes) value = ((value ^ BigInt(byte)) * 0x100000001b3n) & mask;
    return value.toString(16).padStart(16, "0");
  };
  return hash(0xcbf29ce484222325n) + hash(0x84222325cbf29ce4n);
}

export function chatPath(conversationId: string): string {
  return `/chat/${chatRouteId(conversationId)}`;
}

export function resolveChatRouteId(
  routeId: string | undefined,
  conversations: Record<string, unknown>,
): string | null {
  if (!routeId) return null;
  // Existing bookmarks may still contain the old, literal conversation ID.
  if (Object.prototype.hasOwnProperty.call(conversations, routeId)) return routeId;
  return Object.keys(conversations).find((id) => chatRouteId(id) === routeId) ?? null;
}
