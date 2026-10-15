"""Existing access and refresh tokens must stop working after disable."""
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.utils.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    mark_account_disabled,
)


class _Redis:
    def __init__(self):
        self.values = {}

    def set(self, key, value, ex=None):
        self.values[key] = value
        return True

    def exists(self, key):
        return key in self.values

    def get(self, key):
        return self.values.get(key)

    def setnx(self, key, value):
        if key in self.values:
            return False
        self.values[key] = value
        return True


def test_disable_invalidates_access_and_refresh_tokens():
    backend = _Redis()
    with patch("app.utils.security._get_redis", return_value=backend):
        access = create_access_token("alice@example.com", role="user", account_id="a1")
        refresh = create_refresh_token("alice@example.com", role="user", account_id="a1")
        assert decode_token(access)["sub"] == "alice@example.com"
        assert decode_token(refresh, expected_type="refresh")["account_id"] == "a1"
        assert mark_account_disabled("a1")
        for token, kind in ((access, "access"), (refresh, "refresh")):
            with pytest.raises(HTTPException) as exc:
                decode_token(token, expected_type=kind)
            assert exc.value.status_code == 403
