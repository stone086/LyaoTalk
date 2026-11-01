local json = require "prosody.util.json"
local routes
local now = os.time()
local grant = {
  id = "grant-one", jid = "alice@example.org", created = now - 100,
  accessed = now, expires = now + 365 * 86400,
  data = { lyaotalk_device = true, name = "Phone" },
}
local revoked = false
local tokenauth = {
  get_token_info = function (token)
    if token ~= "secret-token:old" or revoked then return nil end
    return { purpose = "oauth2", grant = grant, expires = now + 7 * 86400 }
  end,
  create_token = function () return "secret-token:new" end,
  get_user_grants = function () return revoked and {} or { [grant.id] = grant } end,
  get_grant_info = function (_, id) return id == grant.id and not revoked and grant or nil end,
  revoke_grant = function () revoked = true; return true end,
}
module = {
  host = "example.org",
  depends = function (_, name) assert(name == "tokenauth"); return tokenauth end,
  get_option_string = function () return string.rep("x", 40) end,
  provides = function (_, _, definition) routes = definition.route end,
}
dofile("/tmp/lyaotalk-device-api-test.lua")

local function call(path, body, authorized)
  local event = {
    request = {
      headers = { x_lyaotalk_device_secret = authorized and string.rep("x", 40) or "wrong" },
      body = json.encode(body),
    },
    response = { headers = {} },
  }
  local result = routes["POST /" .. path](event)
  return event.response.status_code, json.decode(result)
end

local status = call("list", { username = "alice" }, false)
assert(status == 403)
local code, result = call("renew", { token = "secret-token:old" }, true)
assert(code == 200 and result.new_token == "secret-token:new" and result.id == grant.id)
code, result = call("list", { username = "alice" }, true)
assert(code == 200 and #result.devices == 1 and result.devices[1].name == "Phone")
code, result = call("revoke-all", { username = "alice" }, true)
assert(code == 200 and #result.revoked == 1 and revoked)
code = call("renew", { token = "secret-token:old" }, true)
assert(code == 401)
print("device-api-auth-renew-list-revoke-ok")
