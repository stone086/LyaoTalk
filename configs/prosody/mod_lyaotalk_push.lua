-- mod_lyaotalk_push.lua
-- Prosody Component module that receives XEP-0357 push notifications
-- and forwards them via HTTP to LyaoTalk backend.
--
-- Install: copy to /usr/lib/prosody-modules/mod_lyaotalk_push/mod_lyaotalk_push.lua
-- Configure: see Component "push.DOMAIN" in prosody.cfg.lua

local jid = require "util.jid";
local st = require "util.stanza";
local http = require "net.http";
local json = require "util.json";

local notify_url = module:get_option_string("lyaotalk_push_url", "http://127.0.0.1:8000/push/notify");
local shared_secret = module:get_option_string("lyaotalk_push_secret", "");

-- Handle <iq type="set"><pubsub><publish node="..."> from registered users
-- which carries the push payload (per XEP-0357 §6).
module:hook("iq-set/host/http://jabber.org/protocol/pubsub:pubsub", function(event)
  local stanza = event.stanza;
  local pubsub = stanza:get_child("pubsub", "http://jabber.org/protocol/pubsub");
  if not pubsub then return; end
  local publish = pubsub:get_child("publish");
  if not publish then return; end

  local from_jid = stanza.attr.from;
  local target_user = jid.bare(from_jid);

  -- Extract notification body if present (XEP-0357 §6 form)
  local item = publish:get_child("item");
  local notif = item and item:get_child("notification", "urn:xmpp:push:0");
  local title = "New message";
  local body = "You have a new message";

  if notif then
    local form = notif:get_child("x", "jabber:x:data");
    if form then
      for field in form:childtags("field") do
        local var = field.attr.var;
        local val = field:get_child_text("value") or "";
        if var == "last-message-body" and val ~= "" then
          body = val;
        elseif var == "message-count" then
          title = "New messages (" .. val .. ")";
        end
      end
    end
  end

  -- Async HTTP POST to LyaoTalk backend
  local payload = json.encode({
    account_jid = target_user,
    title = title,
    body = body,
    secret = shared_secret,
  });

  http.request(notify_url, {
    method = "POST";
    headers = { ["Content-Type"] = "application/json" };
    body = payload;
  }, function(response_body, code)
    if code ~= 200 then
      module:log("warn", "Push relay failed: HTTP %s", tostring(code));
    end
  end);

  -- Acknowledge the IQ
  return event.origin.send(st.reply(stanza));
end);

module:log("info", "LyaoTalk push relay loaded, forwarding to %s", notify_url);
