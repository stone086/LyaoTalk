# LiaoT 2.1.0 Compatibility & Chaos Manual Scenarios

Run these on staging after `scripts/compatibility_chaos_validate.sh` passes locally.

## Browser matrix

| Browser | Minimum scenario |
| --- | --- |
| Chrome / Edge latest | Login, reconnect, send text, upload image/file, OMEMO send/decrypt, Web Push, PWA install |
| Firefox latest | Login, reconnect, send text, upload image/file, OMEMO send/decrypt |
| Safari 16+ macOS/iOS | IndexedDB check, PWA install guidance, Web Push limitations, OMEMO send/decrypt |
| Samsung Internet | Login, upload, reconnect, push behavior if used by target users |

## Chaos scenarios

1. **Network drops while sending**: toggle DevTools offline during a send. The message must remain pending, retry, or fail visibly.
2. **Token expires during upload**: force an expired access token, upload a file, and verify refresh/retry or clear re-login.
3. **Prosody restart**: `sudo systemctl restart prosody` while two users are online. Reconnect must recover without duplicate conversations.
4. **MinIO unavailable**: stop MinIO during upload. UI must show a clear storage error and permit retry.
5. **Browser closes during send**: close tab while in-flight. Reopen and verify no false delivered state.

Record screenshots, timestamps, request IDs, and service logs in `docs/compatibility/compatibility-chaos-results.md`.
