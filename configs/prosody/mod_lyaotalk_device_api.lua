-- Private loopback API for managing Prosody's native OAuth bearer grants.
-- Bind mod_http to 127.0.0.1 and keep this path out of the public reverse proxy.
local json = require "prosody.util.json"
local jid = require "prosody.util.jid"
local tokenauth = module:depends("tokenauth")
local secret = module:get_option_string("lyaotalk_device_api_secret")
assert(secret and #secret >= 32, "lyaotalk_device_api_secret must be configured")

local function respond(event, status, value)
  event.response.status_code = status
  event.response.headers.content_type = "application/json"
  event.response.headers.cache_control = "no-store"
  return json.encode(value)
end

local function authorize(event)
  return event.request.headers.x_lyaotalk_device_secret == secret
end

local function handle(event, action)
  if not authorize(event) then return respond(event, 403, { error = "forbidden" }) end
  if not event.request.body or #event.request.body > 8192 then
    return respond(event, 400, { error = "invalid_body" })
  end
  local data = json.decode(event.request.body)
  if type(data) ~= "table" then return respond(event, 400, { error = "invalid_json" }) end

  if action == "verify" then
    if type(data.token) ~= "string" or #data.token > 4096 then
      return respond(event, 400, { error = "invalid_token" })
    end
    local info = tokenauth.get_token_info(data.token)
    if not info or info.purpose ~= "oauth2" or not info.grant or
       not info.grant.data or not info.grant.data.lyaotalk_device then
      return respond(event, 401, { error = "invalid_token" })
    end
    local username, host = jid.split(info.grant.jid)
    if host ~= module.host then return respond(event, 401, { error = "invalid_host" }) end
    return respond(event, 200, { jid = username .. "@" .. host, id = info.grant.id })
  end
  if action == "renew" then
    if type(data.token) ~= "string" or #data.token > 4096 then
      return respond(event, 400, { error = "invalid_token" })
    end
    local info = tokenauth.get_token_info(data.token)
    if not info or info.purpose ~= "oauth2" or not info.grant or
       not info.grant.data or not info.grant.data.lyaotalk_device then
      return respond(event, 401, { error = "invalid_token" })
    end
    local username, host = jid.split(info.grant.jid)
    if host ~= module.host then return respond(event, 401, { error = "invalid_host" }) end
    local replacement
    if info.expires and info.expires - os.time() < 15 * 24 * 60 * 60 then
      replacement = tokenauth.create_token(info.grant.jid, info.grant,
        "prosody:registered", 30 * 24 * 60 * 60, "oauth2")
      if not replacement then return respond(event, 503, { error = "renew_failed" }) end
    end
    return respond(event, 200, {
      jid = username .. "@" .. host, id = info.grant.id, new_token = replacement,
    })
  end

  local username = data.username
  if type(username) ~= "string" or #username > 128 or
     jid.prep(username .. "@" .. module.host) ~= username .. "@" .. module.host then
    return respond(event, 400, { error = "invalid_username" })
  end
  if action == "list" then
    local grants = tokenauth.get_user_grants(username) or {}
    local result = {}
    for id, grant in pairs(grants) do
      if grant and grant.data and grant.data.lyaotalk_device then
        result[#result + 1] = {
          id = id, name = grant.data.name, created = grant.created,
          accessed = grant.accessed, expires = grant.expires,
        }
      end
    end
    return respond(event, 200, { devices = result })
  end
  if action == "revoke-all" then
    local grants = tokenauth.get_user_grants(username) or {}
    local revoked = {}
    for id, grant in pairs(grants) do
      if grant and grant.data and grant.data.lyaotalk_device then
        local ok = tokenauth.revoke_grant(username, id)
        if not ok then return respond(event, 503, { error = "revoke_failed" }) end
        revoked[#revoked + 1] = id
      end
    end
    return respond(event, 200, { revoked = revoked })
  end
  if action == "issue" then
    local name = data.name
    if type(name) ~= "string" or #name < 1 or #name > 80 then
      return respond(event, 400, { error = "invalid_name" })
    end
    local grant_ttl = 365 * 24 * 60 * 60
    local token_ttl = 30 * 24 * 60 * 60
    local account_jid = username .. "@" .. module.host
    local grant, err = tokenauth.create_grant(account_jid, account_jid, grant_ttl, {
      lyaotalk_device = true, name = name,
    })
    if not grant then return respond(event, 503, { error = err or "grant_failed" }) end
    local token, token_err = tokenauth.create_token(account_jid, grant, "prosody:registered", token_ttl, "oauth2")
    if not token then
      tokenauth.revoke_grant(username, grant.id)
      return respond(event, 503, { error = token_err or "token_failed" })
    end
    return respond(event, 201, { id = grant.id, token = token, expires = os.time() + token_ttl })
  end
  if action == "revoke" then
    if type(data.id) ~= "string" or #data.id > 128 then
      return respond(event, 400, { error = "invalid_id" })
    end
    local grant = tokenauth.get_grant_info(username, data.id)
    if not grant or not grant.data or not grant.data.lyaotalk_device then
      return respond(event, 404, { error = "not_found" })
    end
    local ok, err = tokenauth.revoke_grant(username, data.id)
    if not ok then return respond(event, 503, { error = err or "revoke_failed" }) end
    return respond(event, 200, { revoked = true })
  end
  return respond(event, 404, { error = "not_found" })
end

module:provides("http", {
  default_path = "/internal/lyaotalk-devices";
  route = {
    ["POST /issue"] = function (event) return handle(event, "issue") end;
    ["POST /list"] = function (event) return handle(event, "list") end;
    ["POST /revoke"] = function (event) return handle(event, "revoke") end;
    ["POST /revoke-all"] = function (event) return handle(event, "revoke-all") end;
    ["POST /verify"] = function (event) return handle(event, "verify") end;
    ["POST /renew"] = function (event) return handle(event, "renew") end;
  };
})
