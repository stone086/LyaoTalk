from app.api.routers.push import _notification_tag


def test_notification_tag_is_stable_and_isolates_nodes():
    first = _notification_tag("device-a", "shared-secret")
    assert first == _notification_tag("device-a", "shared-secret")
    assert first != _notification_tag("device-b", "shared-secret")
    assert first != _notification_tag("device-a", "rotated-secret")
    assert "device-a" not in first
    assert len(first) <= 32
