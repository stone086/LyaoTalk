# Android notifications through self-hosted ntfy

LyaoTalk can forward generic new-message alerts from Prosody's XEP-0357 push
component to a private ntfy topic. This path does not use Google push services.
PWA Web Push remains available separately.

## Server setup

1. Keep ntfy bound to loopback and `auth-default-access: deny-all`.
2. Grant `everyone` read-only access to `lt_*` topics. Topic names carry 128 bits
   of random entropy and must be treated as bearer secrets. Never grant anonymous
   write access.
3. Create a dedicated non-admin ntfy user with `lt_*` write-only access and
   generate a token for it. Do not use the ntfy admin account.
4. Put `NTFY_INTERNAL_URL=http://127.0.0.1:2586`,
   `NTFY_PUBLIC_URL=https://ntfy.2-yc.com`, and `NTFY_PUBLISH_TOKEN` in the
   API service's private `.env` file. Keep the token out of Git and logs.
5. Apply the Alembic migration, restart the API, and check the status and test
   endpoints with a user token. Keep a database and config backup for rollback.

The relay sends only `You have a new message`, a LyaoTalk title, and a click
link to the app home page. Sender, message body, JID, and conversation ID are
not sent to ntfy. ntfy may cache generic alerts; topic holders can observe
notification timing. Disabling and re-enabling rotates the topic.

## Android setup

1. Install ntfy from F-Droid for a build without Firebase.
2. In LyaoTalk, open Settings → Messages & alerts and enable ntfy notifications.
3. In ntfy, scan the QR code or subscribe to the displayed URL. Keep the topic
   private. The ntfy app does not use the Prosody password for this mode.
4. Allow notifications and background operation. On devices that aggressively
   stop background services, allow autostart and remove battery optimization
   for ntfy.
5. Send a test alert from LyaoTalk. Test again with the PWA closed, VPN off,
   and the phone locked for at least ten minutes.

The first version opens LyaoTalk when the notification is tapped. Opening the
exact chat requires a separate, privacy-reviewed conversation mapping.
