import os
from pathlib import Path


def get_app_version() -> str:
    env_version = (os.getenv("APP_VERSION") or "").strip()
    if env_version:
        return env_version

    root = Path(__file__).resolve()
    for parent in root.parents:
        version_file = parent / "VERSION"
        if version_file.is_file():
            value = version_file.read_text(encoding="utf-8").strip()
            if value:
                return value

    return "0.0.0"


APP_VERSION = get_app_version()
