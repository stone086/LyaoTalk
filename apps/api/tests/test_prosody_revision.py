"""A direct prosodyctl password rewrite must change the credential marker."""
import importlib.util
from pathlib import Path

import pytest


HELPER = Path(__file__).parents[3] / "configs" / "prosody" / "lyaotalk_registration_helper.py"


def test_internal_account_file_revision_changes_on_direct_rewrite(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("lyaotalk_registration_helper", HELPER)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    monkeypatch.setattr(helper, "DOMAIN", "lyaot.2-yc.com")
    monkeypatch.setattr(helper, "DATA_ROOT", str(tmp_path))
    account_dir = tmp_path / "lyaot%2e2%2dyc%2ecom" / "accounts"
    account_dir.mkdir(parents=True)
    account_file = account_dir / "alice.dat"
    account_file.write_text("old prosody credential")
    before = helper.credential_revision("alice", "lyaot.2-yc.com")
    replacement = account_dir / "replacement"
    replacement.write_text("new prosody credential")
    replacement.replace(account_file)
    after = helper.credential_revision("alice", "lyaot.2-yc.com")
    assert before != after
    unicode_account = account_dir / "mr%e5%91%a8.dat"
    unicode_account.write_text("unicode prosody credential")
    assert len(helper.credential_revision("mr周", "lyaot.2-yc.com")) == 64
    with pytest.raises(ValueError):
        helper.credential_revision("../alice", "lyaot.2-yc.com")
