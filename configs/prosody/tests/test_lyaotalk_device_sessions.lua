local handlers = {}
module = {
  host = "example.org",
  hook = function (_, event, callback) handlers[event] = callback end,
}
local target = {
  username = "alice", host = "example.org",
  sasl_handler = { token_info = { grant = { id = "grant-one" } } },
  close = function (self) self.closed = true end,
}
local other = {
  username = "alice", host = "example.org",
  lyaotalk_device_grant_id = "grant-two",
  close = function (self) self.closed = true end,
}
prosody = { full_sessions = { target, other } }

dofile("/tmp/lyaotalk-device-sessions-test.lua")
assert(handlers["authentication-success"])
assert(handlers["token-grant-revoked"])
handlers["authentication-success"]({ session = target })
assert(target.lyaotalk_device_grant_id == "grant-one")
handlers["token-grant-revoked"]({ id = "grant-one", username = "alice" })
assert(target.closed == true)
assert(other.closed == nil)
print("device-session-revocation-ok")
