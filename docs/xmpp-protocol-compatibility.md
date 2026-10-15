# XMPP protocol compatibility — 2026-10-13

This document distinguishes published protocol revisions from LiaoT's
implemented behavior. It contains no deployment addresses or account details.

| Protocol | Published revision | LiaoT status |
| --- | --- | --- |
| XMPP over WebSocket (RFC 7395) | RFC 7395 | Strophe.js 5.0.0 browser transport; live SASL and direct message delivery tested. |
| Stream Management (XEP-0198) | Current XSF specification | Native Strophe.js 5 support enabled; live negotiation tested. The old application-side handler was removed. Reconnect and resume still need a browser interruption test. |
| HTTP File Upload (XEP-0363) | 1.2.0 (2025-06-17) | LiaoT currently uses an authenticated HTTP API, not XEP-0363 upload slots. PNG and ordinary-file transfers were tested through that API. |
| OMEMO (XEP-0384) | 0.9.1 (2026-04-06) | The legacy namespace remains the default outbound format. Modern namespace parsing exists, but full 0.9.1 send/decrypt, multi-device, and third-party interoperability are not claimed. |
| OMEMO media sharing (XEP-0454) | 0.1.0 (2021-01-26), historical | AES-GCM media helpers exist. Complete third-party media interoperability remains unverified. |

Sources: [Strophe.js](https://github.com/strophe/strophejs),
[XEP-0198](https://xmpp.org/extensions/xep-0198.html),
[XEP-0363](https://xmpp.org/extensions/xep-0363.html),
[XEP-0384](https://xmpp.org/extensions/xep-0384.html), and
[XEP-0454](https://xmpp.org/extensions/xep-0454.html).
