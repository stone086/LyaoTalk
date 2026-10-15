# OMEMO Interop Results

Status: PENDING_REAL_CLIENT_TESTS

## Required clients

| Client | Platform | Result | Evidence | Notes |
|---|---|---:|---|---|
| Conversations | Android / F-Droid | PENDING | screenshot + Prosody stanza excerpt | Test 1:1 encrypted send/receive |
| Gajim | Windows or Linux | PENDING | screenshot + debug log excerpt | Test 1:1 encrypted send/receive |
| Dino | Linux | PENDING | screenshot + debug log excerpt | Test 1:1 encrypted send/receive |

## Test steps

1. Create two users on the staging domain.
2. Log in as user A in LiaoT Web.
3. Log in as user B in the third-party client.
4. Add each other as contacts.
5. Enable OMEMO on both sides.
6. Exchange fingerprints out of band.
7. Send encrypted text message from A to B.
8. Send encrypted text message from B to A.
9. Restart browser/client and verify old encrypted messages remain decryptable.
10. Record result in the table above.

## Failure classification

- `FORMAT_MISMATCH`: stanza namespace/version mismatch.
- `DEVICE_DISCOVERY_FAIL`: device list/prekeys not visible.
- `TRUST_FAIL`: fingerprint or trust state mismatch.
- `DECRYPT_FAIL`: ciphertext received but cannot decrypt.
- `NOT_IMPLEMENTED`: feature intentionally unsupported, for example MUC OMEMO.
