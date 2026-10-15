# OMEMO Interoperability Test Record
nRecommended clients to record: Conversations, Gajim, Dino.

Client:
Version:
Platform:
LiaoT version: 1.8.1
Date:
Tester:
Server/domain:

## Accounts

- LiaoT web account:
- Third-party client account:

## Client capabilities

- OMEMO namespace observed:
- Device ID:
- Fingerprint:
- Trust state before test:

## Test cases

| Case | Expected | Result | Notes |
|---|---|---|---|
| Web → client encrypted text | Client decrypts |  |  |
| Client → web encrypted text | Web decrypts |  |  |
| Web → client encrypted image/file | Client handles or shows safe failure |  |  |
| Browser reload after encrypted exchange | Web still decrypts |  |  |
| Client device reinstall/key reset | Web shows key-change warning |  |  |
| Multi-device peer | All devices receive intended key material |  |  |

## Stanza notes

Paste short, redacted stanza structure only. Do not paste private keys or message plaintext.

```xml
<!-- redacted example here -->
```

## Verdict

- [ ] Pass
- [ ] Partial pass
- [ ] Fail

## Follow-up issues

1.
2.
3.
