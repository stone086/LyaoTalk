from app.core.version import get_app_version


def test_get_app_version_returns_value():
    value = get_app_version()
    assert isinstance(value, str)
    assert value.strip() != ""

