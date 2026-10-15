# LiaoT 1.8.1 Hash-Pinned Python Trusted Build

Version: 1.8.1
Stage: 2 — dependency supply chain and trusted build

## Goal

LiaoT 1.8.1 completes the Python half of the trusted-build work: API runtime dependencies are no longer only version-pinned; every package line in `apps/api/requirements.txt` includes a SHA-256 hash and production installs use `pip install --require-hashes`.

This follows the roadmap stage 2 goal: hash-pinned Python dependencies, npm lockfile verification, SBOM generation, and CI security gates.

## What is enforced now

- Frontend installs must use `npm ci` with `apps/web/package-lock.json`.
- `install.sh` and `manage.sh` must not fall back to uncontrolled `npm install`.
- API runtime installs use:

```bash
pip install --require-hashes -r requirements.txt
```

- `apps/api/requirements.in` remains the human-edited source file.
- `apps/api/requirements.txt` is the generated hash-pinned lock file.
- CI installs API runtime dependencies with `--require-hashes`.
- CI runs frontend build, tests, high-severity production `npm audit`, Python compile checks, `pip-audit`, and Bandit.
- Local validation is available through `scripts/trusted_build_validate.sh --local`.

## Python dependency policy

To update Python dependencies:

```bash
cd apps/api
python -m pip install pip-tools
pip-compile --generate-hashes --output-file=requirements.txt requirements.in
pip install --require-hashes -r requirements.txt
```

Do not hand-write package hashes. Hashes must come from a trusted resolver/build host.

### Python ABI note

The bundled 1.8.1 hash lock was validated in the release environment with CPython 3.13 on Linux x86_64. If the staging/production host uses another ABI, such as CPython 3.11 on Ubuntu 22.04, regenerate the hash lock on that host or in a matching CI runner before production promotion.

## Node dependency policy

The checked-in `apps/web/package-lock.json` is part of the release artifact. Production and CI must use:

```bash
cd apps/web
npm ci
npm run build
npm audit --omit=dev --audit-level=high
```

Do not use `npm install` in production deployment scripts.

## SBOM

Generate SBOMs with:

```bash
bash scripts/generate_sbom.sh
```

Expected outputs:

```text
artifacts/sbom/sbom-python.json
artifacts/sbom/sbom-node.json
```

These files are generated artifacts and are not required to be committed to source archives.

## Release gate

Before promoting a build:

```bash
bash scripts/stage0_validate.sh --local
bash scripts/omemo_runtime_validate.sh
bash scripts/trusted_build_validate.sh --local
cd apps/api && python3 -m venv /tmp/liaot-hash-test && /tmp/liaot-hash-test/bin/pip install --require-hashes -r requirements.txt
cd apps/web && npm ci && npm run build && npm test && npm audit --omit=dev --audit-level=high
python3 -m compileall -q apps/api/app apps/api/alembic
```
