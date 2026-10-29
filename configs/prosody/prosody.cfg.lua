-- =============================================================================
-- LyaoTalk Prosody config template
-- Placeholder XMPP_DOMAIN will be replaced by install.sh
-- Placeholder XMPP_FRONTEND_ORIGIN is the https://hostname of the web client
-- =============================================================================

plugin_paths = { "/usr/lib/prosody-modules" }

admins = { "admin@XMPP_DOMAIN" }

modules_enabled = {
  "roster";
  "saslauth";
  "tls";
  "dialback";
  "disco";
  "carbons";
  "pep";
  "private";
  "bookmarks";
  "blocklist";
  -- LyaoTalk Web uses API + MinIO; the separate upload component below
  -- provides XEP-0363 to native XMPP clients such as Conversations.
  "vcard4";
  "vcard_legacy";
  "mam";
  "smacks";
  "csi";
  "websocket";
  "bosh";
  "http";
  "cloud_notify";   -- XEP-0357 push relay (community module)
  "lyaotalk_push_id"; -- stable original message key for ntfy de-duplication
  -- XEP-0215 external_services is unavailable in Ubuntu 22.04's Prosody
  -- modules package. Install a compatible module before enabling it.
  "turncredentials";  -- coturn REST credentials for older clients/modules
  "version";
  "uptime";
  "time";
  "ping";
  "admin_adhoc";
  -- Note: NOT loading 'register' — `allow_registration = false` blocks it
  -- but having the module loaded is unnecessary attack surface.
  -- Account creation goes through the FastAPI /auth/register endpoint
  -- which calls prosodyctl directly.
}

modules_disabled = {
  "register";       -- in-band registration (XEP-0077): we use API instead
  "saslauth_legacy"; -- legacy SASL mechanisms (PLAIN over plaintext)
}

allow_registration = false
c2s_require_encryption = true
s2s_require_encryption = true
s2s_secure_auth = true  -- Verify remote server TLS certificates
authentication = "internal_hashed"
storage = "internal"

-- TLS hardening: refuse TLS 1.0 / 1.1 (broken ciphers, no PFS in some).
-- Also disable static-RSA cipher suites that don't provide forward secrecy.
ssl = {
  protocol = "tlsv1_2+";
  ciphers = "ECDHE+AES:!aNULL:!eNULL:!LOW:!3DES:!MD5:!RC4:!EXP:!PSK:!SRP:!DSS";
  options = { "no_compression"; "single_dh_use"; "single_ecdh_use"; };
  certificate = "/etc/prosody/certs/XMPP_DOMAIN/fullchain.pem";
  key = "/etc/prosody/certs/XMPP_DOMAIN/privkey.pem";
  -- DH params should be regenerated per-deployment; install.sh creates these.
  dhparam = "/etc/prosody/certs/dh-2048.pem";
}

-- Stanza size limits: prevent memory-exhaustion DoS from a single huge stanza.
-- 256KB is enough for any legitimate XMPP traffic including OMEMO key
-- material and inline base64 thumbnails. Without these, a malicious client
-- or peer server could send a 100MB <message> and force allocation.
c2s_stanza_size_limit = 262144  -- 256KB per c2s stanza
s2s_stanza_size_limit = 524288  -- 512KB per s2s stanza (slightly more headroom for federation)
c2s_close_timeout = 5  -- close stalled c2s sessions after 5s of no progress

archive_expires_after = "3d"
default_archive_policy = true
max_archive_query_results = 100

-- HTTP CORS: scope to the LyaoTalk frontend origin only. Wildcard "*" lets
-- any third-party website call Prosody's HTTP endpoints (BOSH, file upload
-- metadata) using credentials in the browser; that's a recipe for CSRF +
-- credential abuse. install.sh substitutes XMPP_FRONTEND_ORIGIN with the
-- actual https://domain of the web app.
http_cors_override = {
  bosh = { enabled = true; origins = { "XMPP_FRONTEND_ORIGIN" }; credentials = true; };
  http_files = { enabled = true; origins = { "XMPP_FRONTEND_ORIGIN" }; credentials = false; };
  websocket = { enabled = true; origins = { "XMPP_FRONTEND_ORIGIN" }; credentials = true; };
}
consider_websocket_secure = true
consider_bosh_secure = true

http_interfaces = { "127.0.0.1" }
http_ports = { 5280 }
https_ports = {}
http_max_content_size = 101 * 1024 * 1024 -- Prosody 0.11 upload parser reads the global limit

-- BOSH session hygiene: shorter inactivity = faster cleanup of abandoned
-- mobile clients that closed without sending </stream:stream>.
bosh_max_inactivity = 60     -- seconds the server waits between long-polls
bosh_max_polling = 5         -- seconds minimum between polls (DoS guard)

log = {
  info = "/var/log/prosody/prosody.log";
  error = "/var/log/prosody/prosody.err";
}

-- TURN/STUN configuration for Jingle calls (XEP-0215)
-- Install.sh fills TURN_SECRET; coturn config also uses it
external_service_secret = "TURN_SECRET_PLACEHOLDER"
external_service_ttl = 86400
external_services = {
  { type = "stun"; transport = "udp"; host = "turn.XMPP_DOMAIN"; port = 3478 };
  { type = "stun"; transport = "tcp"; host = "turn.XMPP_DOMAIN"; port = 3478 };
  { type = "turn"; transport = "udp"; host = "turn.XMPP_DOMAIN"; port = 3478; secret = true; ttl = 86400 };
  { type = "turn"; transport = "tcp"; host = "turn.XMPP_DOMAIN"; port = 3478; secret = true; ttl = 86400 };
}
turncredentials_host = "turn.XMPP_DOMAIN"
turncredentials_port = 3478
turncredentials_secret = "TURN_SECRET_PLACEHOLDER"
turncredentials_ttl = 86400

-- Push notification relay configuration
-- mod_cloud_notify forwards push notifications to the LyaoTalk FastAPI backend,
-- which then dispatches them as Web Push to subscribed PWA clients.
push_notification_with_body = false  -- privacy: don't include message body in push
push_notification_with_sender = false  -- ditto for sender JID
push_max_errors = 16  -- upstream default; 5 was too aggressive — legitimate
                      -- FCM hiccups would deregister real users
push_max_devices = 5

VirtualHost "XMPP_DOMAIN"
  authentication = "internal_hashed"

Component "conference.XMPP_DOMAIN" "muc"
  name = "LyaoTalk Conference"
  modules_enabled = {
    "muc_mam";
  }
  -- Restrict room creation to local users only. Without this any federated
  -- account on the public XMPP network can create rooms on our MUC service,
  -- which is a spam / abuse / disk-fill vector. "local" allows our own
  -- accounts; admins can still create rooms regardless.
  restrict_room_creation = "local"
  muc_room_default_persistent = true
  max_history_messages = 100
  muc_log_by_default = false  -- per-room MAM, not all rooms by default

-- Native XMPP clients discover this XEP-0363 service via the upload component.
-- Prosody 13 includes mod_http_file_share; its HTTP path is /file_share.
Component "upload.XMPP_DOMAIN" "http_file_share"
  modules_disabled = { "s2s" }
  http_host = "upload.XMPP_DOMAIN"
  http_external_url = "https://upload.XMPP_DOMAIN/"
  http_file_share_size_limit = 100 * 1024 * 1024
  http_file_share_daily_quota = 500 * 1024 * 1024
  http_file_share_expires_after = "30 days"


-- =====================================================
-- Push notification appserver Component (LyaoTalk custom relay)
-- See configs/prosody/mod_lyaotalk_push.lua
-- =====================================================
Component "push.XMPP_DOMAIN"
  modules_enabled = { "lyaotalk_push" }
  lyaotalk_push_url = "http://127.0.0.1:8000/push/notify"
  lyaotalk_push_secret = "PUSH_SHARED_SECRET_PLACEHOLDER"
