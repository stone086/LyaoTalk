-- Track the token grant used by each XMPP session so revoking one device
-- closes only sessions authenticated with that grant.
module:hook("authentication-success", function (event)
  local session = event.session
  local handler = session and session.sasl_handler
  local info = handler and handler.token_info
  local grant = info and info.grant
  if grant and grant.id then
    session.lyaotalk_device_grant_id = grant.id
  end
end)

module:hook("token-grant-revoked", function (event)
  if not event.id or not event.username then return end
  local bare_jid = event.username .. "@" .. module.host
  for _, session in pairs(prosody.full_sessions) do
    if session.username and session.host and
       session.username .. "@" .. session.host == bare_jid and
       session.lyaotalk_device_grant_id == event.id then
      session:close({ condition = "not-authorized", text = "Device authorization revoked" })
    end
  end
end)
