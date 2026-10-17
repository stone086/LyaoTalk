# iPhone message notifications

LyaoTalk uses Web Push for iPhone Home Screen apps (iOS 16.4 or newer).
The user opens LyaoTalk in Safari, adds it to the Home Screen, launches the
installed app, and enables **PWA Push** in Settings for each XMPP account.
The browser permission request must follow that tap. The app does not need
to stay open for the service worker to display a notification.

## Delivery path

1. The browser creates one Web Push subscription. FastAPI stores it with an
   opaque, random XEP-0357 node for each account on that browser.
2. The connected XMPP client enables that node at `push.<XMPP_DOMAIN>`.
   It repeats the registration after reconnecting.
3. Prosody `mod_cloud_notify` publishes to the node when the client needs
   a push. `mod_lyaotalk_push` passes the node to FastAPI over localhost.
4. FastAPI finds the matching subscription and sends an encrypted Web Push
   request to the browser push provider. The service worker shows a generic
   notification. Message bodies and sender JIDs are excluded by the Prosody
   configuration to protect message privacy.

## Deployment

- Apply Alembic migration `0011_multi_account_push` before updating the API.
- Deploy the new web and API builds together with the updated
  `configs/prosody/mod_lyaotalk_push.lua`, then restart the component.
- Confirm VAPID private/public keys and `PUSH_SHARED_SECRET` are configured,
  and that the Prosody component uses the same secret as FastAPI.
- Allow outbound HTTPS to the browser push providers, including Apple's
  `*.push.apple.com` endpoints.

## Real-device acceptance

On an iPhone, enable notifications from the installed Home Screen app. Send
messages while it is open, backgrounded, closed, and while the screen is
locked. Check direct chats, group chats, two accounts on one installation,
reconnect, disable/re-enable, and account removal. Measure the time from
message acceptance to notification display. Also verify behavior with Focus
and notification permissions changed in iOS Settings. Delivery timing is
subject to iOS notification and network conditions.
