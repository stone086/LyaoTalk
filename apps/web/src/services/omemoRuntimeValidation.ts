import type { DeviceRecord, DeviceTrustState } from "./omemoTrust";

export type RuntimeValidationSeverity = "ok" | "warning" | "critical";

export interface RuntimeValidationFinding {
  id: string;
  severity: RuntimeValidationSeverity;
  message: string;
}

export interface PreKeyRuntimeStatus {
  remaining: number;
  threshold: number;
  shouldReplenish: boolean;
}

const FINGERPRINT_HEX_RE = /^[0-9a-f]{64}$/i;

export function compactFingerprint(value: string): string {
  return value.replace(/[^0-9a-f]/gi, "").toLowerCase();
}

export function isValidIdentityFingerprint(value: string): boolean {
  return FINGERPRINT_HEX_RE.test(compactFingerprint(value));
}

export function formatIdentityFingerprint(value: string): string {
  const compact = compactFingerprint(value);
  if (!FINGERPRINT_HEX_RE.test(compact)) return value.trim();
  return compact.match(/.{1,8}/g)?.join(" ") ?? compact;
}

export function shouldReplenishPreKeys(remaining: number, threshold = 20): PreKeyRuntimeStatus {
  const safeRemaining = Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0;
  const safeThreshold = Number.isFinite(threshold) ? Math.max(1, Math.floor(threshold)) : 20;
  return {
    remaining: safeRemaining,
    threshold: safeThreshold,
    shouldReplenish: safeRemaining < safeThreshold,
  };
}

export function trustStateSeverity(state: DeviceTrustState, keyChanged = false): RuntimeValidationSeverity {
  if (keyChanged || state === "untrusted") return "critical";
  if (state === "unverified" || state === "blind_trust") return "warning";
  return "ok";
}

export function summarizeDeviceTrust(records: DeviceRecord[]): RuntimeValidationFinding[] {
  if (records.length === 0) {
    return [{
      id: "omemo.no_peer_devices",
      severity: "warning",
      message: "No peer OMEMO devices are recorded yet; send or receive an encrypted message before trusting this session.",
    }];
  }

  return records.map((record) => {
    const severity = trustStateSeverity(record.trustState, Boolean(record.keyChanged));
    const fp = formatIdentityFingerprint(record.fingerprint);
    const prefix = `${record.jid} device ${record.deviceId}`;
    if (record.keyChanged) {
      return {
        id: `omemo.key_changed.${record.deviceId}`,
        severity,
        message: `${prefix} changed identity fingerprint. Previous: ${record.previousFingerprint ?? "unknown"}. Current: ${fp}. Verify out-of-band before sending sensitive messages.`,
      };
    }
    if (record.trustState === "verified") {
      return {
        id: `omemo.verified.${record.deviceId}`,
        severity,
        message: `${prefix} is verified with fingerprint ${fp}.`,
      };
    }
    if (record.trustState === "blind_trust") {
      return {
        id: `omemo.blind_trust.${record.deviceId}`,
        severity,
        message: `${prefix} is blindly trusted. Verify the fingerprint out-of-band when possible: ${fp}.`,
      };
    }
    return {
      id: `omemo.${record.trustState}.${record.deviceId}`,
      severity,
      message: `${prefix} is ${record.trustState}. Fingerprint: ${fp}.`,
    };
  });
}

export function summarizePreKeyStatus(remaining: number, threshold = 20): RuntimeValidationFinding {
  const status = shouldReplenishPreKeys(remaining, threshold);
  return {
    id: status.shouldReplenish ? "omemo.prekeys.low" : "omemo.prekeys.ok",
    severity: status.shouldReplenish ? "warning" : "ok",
    message: status.shouldReplenish
      ? `Only ${status.remaining} OMEMO prekeys remain; replenish below threshold ${status.threshold}.`
      : `${status.remaining} OMEMO prekeys remain; threshold is ${status.threshold}.`,
  };
}
