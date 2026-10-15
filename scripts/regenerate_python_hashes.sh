#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../apps/api"
python3 -m venv /tmp/liaot-hash-venv
. /tmp/liaot-hash-venv/bin/activate
python -m pip install --upgrade pip pip-tools
pip-compile --generate-hashes --output-file=requirements.txt requirements.in
pip install --require-hashes -r requirements.txt
python - <<'PY'
import platform, sys
print('python=', sys.version)
print('platform=', platform.platform())
PY
