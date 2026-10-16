# XMPP Configuration Notes

LyaoTalk uses Prosody as the XMPP backend.

## Main file
- `/etc/prosody/prosody.cfg.lua`
- Template source in repo: `configs/prosody/prosody.cfg.lua`

## Recommended modules
- `roster`, `saslauth`, `tls`, `disco`
- `carbons`, `mam`, `smacks`, `csi`
- `websocket`, `http_upload`, `vcard4`, `bookmarks`, `blocklist`

## Validation
```bash
prosodyctl check config
systemctl restart prosody
```
