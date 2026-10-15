import { getOrCreateLocalKeyPair } from "@/services/e2ee";

export interface OmemoDeviceFingerprint {
  deviceId: number;
  fingerprint: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function formatFingerprint(hex: string): string {
  return hex.match(/.{1,4}/g)?.join(" ") ?? hex;
}

export async function getOmemoFingerprintForJid(jid: string, accountId?: string): Promise<string> {
  const normalizedJid = jid.trim().toLowerCase();
  const keyPair = accountId ? await getOrCreateLocalKeyPair(accountId) : null;
  const seed = keyPair ? `${normalizedJid}|${keyPair.publicRawB64}` : normalizedJid;
  const encoded = new TextEncoder().encode(seed);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hex = toHex(new Uint8Array(digest)).toUpperCase();
  return formatFingerprint(hex);
}
