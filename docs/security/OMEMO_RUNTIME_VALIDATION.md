# OMEMO Runtime Validation Checklist

Version: 1.8.1

This document turns the 1.7.0 trust foundation into a repeatable runtime validation flow. It does not claim that OMEMO is complete until these checks are executed against a staging deployment and at least two real clients.

## Scope

Validate the following before promoting a build beyond the OMEMO trust foundation:

- browser-to-browser encrypted message flow
- trust state persistence after browser restart
- key-change warning behavior
- prekey low-watermark behavior
- Forward Secrecy evidence collection
- interoperability notes for Conversations, Gajim, and Dino

## 1. Browser-to-browser encrypted message flow

1. Create two staging users: `alice@DOMAIN` and `bob@DOMAIN`.
2. Open Alice in Chrome profile A and Bob in Chrome/Edge/Firefox profile B.
3. Confirm both users have OMEMO enabled.
4. Alice sends Bob three encrypted text messages.
5. Bob replies with three encrypted text messages.
6. Attach one image and one small file using the encrypted media path.
7. Record whether both browsers can decrypt after refresh.

Pass criteria:

- no plaintext body is shown in Prosody debug logs for encrypted messages
- both sides can decrypt after page refresh
- failed decrypts are shown as explicit errors, not blank messages

## 2. Trust persistence test

1. Open a peer's OMEMO trust panel.
2. Mark a peer device as verified.
3. Reload the browser.
4. Close and reopen the browser.
5. Confirm the device remains verified.

Pass criteria:

- trust state survives reload and full browser restart
- legacy localStorage fallback does not overwrite IndexedDB data with stale trust states

## 3. Key-change warning test

1. Log in as Bob with a clean browser profile or clear Bob's OMEMO identity storage.
2. Generate a new Bob device identity.
3. Alice receives or discovers the same Bob device ID with a different fingerprint.
4. Open Alice's OMEMO trust panel.

Pass criteria:

- the affected device is downgraded to `unverified`
- the UI shows an explicit key-change warning
- Alice must verify again before treating that device as trusted

## 4. PreKey low-watermark test

1. Record current prekey count for the account.
2. Simulate or trigger consumption until remaining prekeys fall below 20.
3. Reconnect the account or wait for the periodic check.
4. Confirm prekeys are replenished.

Pass criteria:

- remaining prekeys below threshold trigger replenishment
- replenishment failures are logged and visible to the operator
- no message silently downgrades to plaintext because prekeys are low

## 5. Forward Secrecy evidence collection

Use a staging-only browser profile.

1. A sends B ten encrypted messages.
2. Export or snapshot the current OMEMO session state.
3. A sends B ten more encrypted messages.
4. Attempt to decrypt messages from step 3 using the stale snapshot from step 2.

Pass criteria:

- stale state cannot decrypt future messages after the ratchet has advanced
- test notes include exact browser, account, and build version

## 6. Third-party client interop

Use `docs/security/OMEMO_INTEROP_TEST_TEMPLATE.md` for each client:

- Conversations on Android
- Gajim on Windows or Linux
- Dino on Linux

Pass criteria for a release claim:

- at least two third-party clients can exchange encrypted 1:1 messages with LiaoT
- stanza differences are documented if one client fails
- MUC OMEMO is not advertised unless it has its own test evidence

## Release gate

Do not label OMEMO as complete until all of the following are checked:

- [ ] Browser-to-browser encrypted flow passed
- [ ] Trust persistence passed
- [ ] Key-change warning passed
- [ ] PreKey replenishment passed
- [ ] Forward Secrecy evidence collected
- [ ] At least two third-party client interop tests passed
- [ ] MUC OMEMO limitation documented in the UI and docs
