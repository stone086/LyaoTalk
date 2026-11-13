-- Attach an opaque, stable original-message key to LyaoTalk push publications.
-- The push IQ id itself is freshly randomized by mod_cloud_notify and cannot
-- identify duplicate notifications for a single chat message.
local hashes = require "util.hashes";
local jid = require "util.jid";
local http = require "net.http";
local json = require "util.json";
local notify_url = module:get_option_string("lyaotalk_push_url", "http://127.0.0.1:8000/push/notify");
local read_url = notify_url:gsub("/notify$", "/read");
local shared_secret = module:get_option_string("lyaotalk_push_secret", "");

module:hook("cloud_notify/push", function(event)
  local push_info = event.push_info;
  local node = push_info and push_info.node;
  if type(node) ~= "string" then return end
  -- mod_cloud_notify marks receipts, chat states, pings and other empty
  -- stanzas as unimportant. They are not new chat messages for ntfy.
  if not event.important then return true end

  local original = event.original_stanza;
  local notification = event.notification_payload;
  if not original or original.name ~= "message" or not notification then return end

  local origin = original:get_child("origin-id", "urn:xmpp:sid:0");
  local id = original.attr.id or (origin and origin.attr.id);
  local sender = original.attr.from;
  if not id or id == "" or not sender or sender == "" then return end

  -- Only a digest crosses the internal relay; no JID or message content does.
  local key = hashes.sha256(jid.bare(sender) .. "\0" .. id, true);
  notification:tag("message-id", { xmlns = "urn:lyaotalk:push:1", id = key }):up();
end, 100);

local function mark_displayed(event)
  local stanza = event.stanza;
  if stanza._lyaotalk_read_sent then return end
  local origin = event.origin;
  if not origin or not origin.username or origin.host ~= module.host then return end
  local displayed = stanza:get_child("displayed", "urn:xmpp:chat-markers:0");
  local original_id = displayed and displayed.attr.id;
  local original_sender = stanza.attr.to and jid.bare(stanza.attr.to);
  if not original_id or original_id == "" or not original_sender then return end
  stanza._lyaotalk_read_sent = true;
  local key = hashes.sha256(original_sender .. "\0" .. original_id, true);
  local payload = json.encode({
    account_jid = origin.username .. "@" .. module.host;
    message_id = key;
    secret = shared_secret;
  });
  http.request(read_url, {
    method = "POST";
    headers = { ["Content-Type"] = "application/json" };
    body = payload;
  }, function(_, code)
    if code ~= 200 then module:log("warn", "Read relay failed: HTTP %s", tostring(code)) end
  end);
end

module:hook("pre-message/bare", mark_displayed, 100);
module:hook("pre-message/full", mark_displayed, 100);
