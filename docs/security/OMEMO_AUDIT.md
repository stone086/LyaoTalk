# OMEMO Audit - LiaoT 1.7.0

This document starts Stage 1 from the LiaoT roadmap: OMEMO / encryption hardening. It records what is true in the current codebase and what still needs external interoperability testing.

## Current implementation answers

1. **Library**
   - The modern OMEMO integration uses `@privacyresearch/libsignal-protocol-typescript` through `apps/web/src/services/omemo/*`.
   - `apps/web/src/services/e2ee.ts` remains as a legacy compatibility path and uses WebCrypto primitives directly.

2. **Identity key storage**
   - Modern OMEMO keys are handled by `OmemoStore` under `apps/web/src/services/omemo/store.ts`.
   - Legacy E2EE key material has been migrated toward IndexedDB through the `liaot-secure` database in `e2ee.ts`.
   - Remaining non-secret device id metadata is still stored in `localStorage`.

3. **Session state persistence**
   - Legacy session state is persisted in IndexedDB via the secure key/value store.
   - Modern OMEMO session persistence depends on `OmemoStore`; this still needs browser restart testing against Conversations/Gajim.

4. **PreKeys**
   - Modern OMEMO prekeys are generated and replenished by `replenishPreKeys(accountId)` in `apps/web/src/services/omemo/keys.ts`.
   - The low-water replenishment exists in code, but Stage 1 still requires a real prekey exhaustion test.

5. **Protocol version**
   - The integration documents XEP-0384 legacy namespace `eu.siacs.conversations.axolotl` as the main interop target.
   - `e2ee.ts` also declares `urn:xmpp:omemo:2` as a supported namespace for inbound parsing, but the default outbound namespace is still the legacy namespace.

6. **Encryption scope**
   - 1:1 OMEMO is the supported target.
   - MUC OMEMO is explicitly not complete; group chat should not be advertised as end-to-end encrypted.
   - AES-GCM media support exists for encrypted media payloads, but full OMEMO media-sharing interoperability still needs testing.

## Changes added in 1.7.0

- Added a shared trust-state model: `unverified`, `verified`, `untrusted`, and `blind_trust`.
- Added IndexedDB-backed peer device trust records, with localStorage compatibility for older state.
- Added fingerprint-change detection. A changed fingerprint now downgrades the device to `unverified` and preserves the previous fingerprint for the UI.
- Updated `OmemoTrustView` to show own device id, own fingerprint, QR payload, peer device states, and key-change warnings.
- Added i18n strings for key-change warnings and the new trust states.

## Stage 1 remaining checklist

- Verify trust records on Chrome, Edge, Firefox, Safari, and mobile PWA.
- Complete QR scan/import flow; 1.7.0 only generates the QR payload and manual verify/reject UI.
- Run real interoperability tests with Conversations, Gajim, and Dino.
- Run prekey exhaustion and replenishment tests.
- Run forward secrecy state snapshot tests.
- Do not mark MUC OMEMO as complete until per-member/per-device encryption and membership-change handling are tested.
