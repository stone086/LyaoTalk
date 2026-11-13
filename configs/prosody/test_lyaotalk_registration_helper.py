"""Check that the restricted helper exposes only validated admin actions."""

import json
import unittest
from unittest.mock import patch

import lyaotalk_registration_helper as helper


class FakeConnection:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode() + b"\n"
        self.response = None

    def settimeout(self, _timeout):
        pass

    def recv(self, _size):
        data, self.payload = self.payload, b""
        return data

    def sendall(self, data):
        self.response = json.loads(data)


class HelperAdminActionsTest(unittest.TestCase):
    def setUp(self):
        self.domain = "2-yc.com"

    def call(self, payload):
        conn = FakeConnection({"domain": self.domain, **payload})
        with patch.object(helper, "DOMAIN", self.domain):
            helper.handle(conn)
        return conn.response

    def test_list_users_returns_only_jids(self):
        with patch.object(helper, "_shell", return_value={"returncode": 0, "stdout": "sdc@2-yc.com\nfoo@other.test\nOK: 1 users\n"}):
            self.assertEqual(self.call({"action": "list_users"})["users"], ["sdc@2-yc.com"])

    def test_rejects_invalid_user_before_shell(self):
        with patch.object(helper, "_shell") as shell:
            result = self.call({"action": "delete_user", "username": "../sdc"})
            self.assertNotEqual(result["returncode"], 0)
            shell.assert_not_called()

    def test_destroy_room_uses_validated_jid(self):
        with patch.object(helper, "_shell", return_value={"returncode": 0, "stdout": "Result: true\n"}) as shell:
            self.assertEqual(self.call({"action": "destroy_room", "room": "资料库"})["returncode"], 0)
            self.assertIn("资料库@conference.2-yc.com", shell.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
