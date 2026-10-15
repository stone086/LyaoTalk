import { describe, expect, it } from "vitest";
import {
  compactFingerprint,
  formatIdentityFingerprint,
  isValidIdentityFingerprint,
  shouldReplenishPreKeys,
  summarizeDeviceTrust,
  summarizePreKeyStatus,
} from "./omemoRuntimeValidation";

const FP_A = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const FP_B = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

describe("omemoRuntimeValidation", () => {
  it("normalizes and validates 32-byte identity fingerprints", () => {
    const spaced = "00112233 44556677 8899AABB CCDDEEFF 00112233 44556677 8899AABB CCDDEEFF";
    expect(compactFingerprint(spaced)).toBe(FP_A);
    expect(isValidIdentityFingerprint(spaced)).toBe(true);
    expect(formatIdentityFingerprint(spaced)).toBe("00112233 44556677 8899aabb ccddeeff 00112233 44556677 8899aabb ccddeeff");
    expect(isValidIdentityFingerprint("not-a-fingerprint")).toBe(false);
  });

  it("warns when prekeys fall below threshold", () => {
    expect(shouldReplenishPreKeys(19, 20)).toEqual({ remaining: 19, threshold: 20, shouldReplenish: true });
    expect(shouldReplenishPreKeys(20, 20)).toEqual({ remaining: 20, threshold: 20, shouldReplenish: false });
    expect(summarizePreKeyStatus(5, 20).severity).toBe("warning");
  });

  it("marks key changes as critical runtime findings", () => {
    const findings = summarizeDeviceTrust([{
      jid: "peer@example.com",
      deviceId: 42,
      fingerprint: FP_B,
      previousFingerprint: FP_A,
      trustState: "unverified",
      firstSeen: 1,
      lastSeen: 2,
      keyChanged: true,
    }]);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].id).toBe("omemo.key_changed.42");
    expect(findings[0].message).toContain("changed identity fingerprint");
  });

  it("summarizes verified, blind trust, and empty trust states", () => {
    expect(summarizeDeviceTrust([])[0].severity).toBe("warning");
    expect(summarizeDeviceTrust([{
      jid: "peer@example.com",
      deviceId: 7,
      fingerprint: FP_A,
      trustState: "verified",
      firstSeen: 1,
      lastSeen: 1,
    }])[0].severity).toBe("ok");
    expect(summarizeDeviceTrust([{
      jid: "peer@example.com",
      deviceId: 8,
      fingerprint: FP_A,
      trustState: "blind_trust",
      firstSeen: 1,
      lastSeen: 1,
    }])[0].severity).toBe("warning");
  });
});
