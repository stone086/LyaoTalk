# OMEMO Interoperability Matrix

Use this checklist before declaring a release OMEMO-compatible with Conversations and Gajim.

## Test Accounts

- Account A: LiaoT Web
- Account B: Conversations Android
- Account C: Gajim Desktop
- Optional second device for Account A: another LiaoT browser profile or another XMPP client

## Required Server Features

- PEP/pubsub enabled
- MAM enabled
- Carbons enabled
- WebSocket enabled
- OMEMO device list and bundle nodes readable by contacts

## Core Matrix

| Case | Sender | Receiver | Expected result | Status |
| --- | --- | --- | --- | --- |
| 1 | LiaoT | Conversations | First encrypted text decrypts after fingerprint verification | TODO |
| 2 | Conversations | LiaoT | First encrypted text decrypts and shows encrypted state | TODO |
| 3 | LiaoT | Gajim | First encrypted text decrypts after fingerprint verification | TODO |
| 4 | Gajim | LiaoT | First encrypted text decrypts and shows encrypted state | TODO |
| 5 | Conversations | Gajim | Baseline encrypted text works outside LiaoT | TODO |
| 6 | Gajim | Conversations | Baseline encrypted text works outside LiaoT | TODO |

## Device And Trust Cases

| Case | Scenario | Expected result | Status |
| --- | --- | --- | --- |
| 7 | Receiver has two devices online | Both receiver devices can decrypt new messages | TODO |
| 8 | Receiver has one device offline | Offline device decrypts message after reconnect | TODO |
| 9 | Receiver adds a new device | LiaoT detects a new untrusted fingerprint and blocks send | TODO |
| 10 | User verifies new device | LiaoT sends after verification | TODO |
| 11 | Receiver removes a device | Removed device stops receiving new encrypted keys | TODO |
| 12 | Peer fingerprint changes | LiaoT blocks send until fingerprint is reverified | TODO |

## Message Behavior Cases

| Case | Scenario | Expected result | Status |
| --- | --- | --- | --- |
| 13 | Long text, 2,000+ characters | Message decrypts fully on receiver | TODO |
| 14 | Offline encrypted message | Receiver gets and decrypts it after login | TODO |
| 15 | Reconnect after network loss | Next encrypted message still decrypts | TODO |
| 16 | MAM history reload | Encrypted messages remain readable or show clear decrypt failure state | TODO |
| 17 | Untrusted device | Send is blocked with fingerprint instructions | TODO |
| 18 | Verified device | Send succeeds with encrypted indicator | TODO |

## Pass Criteria

- All required cases are marked pass.
- No encrypted message is silently shown as plaintext.
- No message is sent to an untrusted device.
- Fingerprint changes are visible to the user before sending.
- Failures include enough client/server logs to reproduce.

## Evidence To Save

- Sender and receiver screenshots.
- Browser console log for LiaoT failures.
- Prosody log excerpt for pubsub, MAM, or stanza errors.
- Exact client versions for Conversations and Gajim.
