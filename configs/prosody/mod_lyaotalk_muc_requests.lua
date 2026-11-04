-- Notify room owners and admins when an unaffiliated user tries to enter a
-- members-only room. The normal MUC membership check still rejects the join.
local jid = require "prosody.util.jid";
local st = require "prosody.util.stanza";
local recent = {};

module:hook("muc-occupant-pre-join", function(event)
  local room = event.room;
  if not room._data.members_only then return end
  local applicant = jid.bare(event.stanza.attr.from or "");
  if not applicant or room:get_affiliation(applicant) then return end
  local key = room.jid .. "\0" .. applicant;
  local now = os.time();
  if recent[key] and now - recent[key] < 300 then return end
  recent[key] = now;
  for recipient, affiliation in room:each_affiliation() do
    if affiliation == "owner" or affiliation == "admin" then
      module:send(st.message({ from = room.jid; to = recipient; type = "chat" })
        :tag("join-request", { xmlns = "urn:lyaotalk:muc-join-request:1"; jid = applicant; room = room.jid }):up()
        :tag("body"):text("Group join request from " .. applicant));
    end
  end
end, -4);
