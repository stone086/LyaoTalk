-- Attach an opaque, stable original-message key to LyaoTalk push publications.
-- The push IQ id itself is freshly randomized by mod_cloud_notify and cannot
-- identify duplicate notifications for a single chat message.
local hashes = require "util.hashes";

module:hook("cloud_notify/push", function(event)
  local push_info = event.push_info;
  local node = push_info and push_info.node;
  if type(node) ~= "string" or not node:match("^ntfy_") then return end
  -- mod_cloud_notify marks receipts, chat states, pings and other empty
  -- stanzas as unimportant. They are not new chat messages for ntfy.
  if not event.important then return true end

  local original = event.original_stanza;
  local notification = event.notification_payload;
  if not original or original.name ~= "message" or not notification then return end

  local origin = original:get_child("origin-id", "urn:xmpp:sid:0");
  local id = (origin and origin.attr.id) or original.attr.id;
  local sender = original.attr.from;
  if not id or id == "" or not sender or sender == "" then return end

  -- Only a digest crosses the internal relay; no JID or message content does.
  local key = hashes.sha256(sender .. "\0" .. id, true);
  notification:tag("message-id", { xmlns = "urn:lyaotalk:push:1", id = key }):up();
end, 100);
