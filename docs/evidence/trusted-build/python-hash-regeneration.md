# Python Hash Regeneration Evidence

Status: PENDING_STAGING_RUN

The 1.8.1 hash-pinned requirements were generated in the build environment. For production, regenerate hashes on the target Ubuntu/Python baseline and commit the resulting lockfile if it differs.

## Target environment

| Field | Value |
|---|---|
| OS | PENDING |
| Python | PENDING |
| pip | PENDING |
| pip-tools | PENDING |
| Architecture | PENDING |

## Commands

```bash
cd apps/api
python3 -m venv /tmp/liaot-hash-venv
. /tmp/liaot-hash-venv/bin/activate
python -m pip install --upgrade pip pip-tools
pip-compile --generate-hashes --output-file=requirements.txt requirements.in
pip install --require-hashes -r requirements.txt
```

## Result

- `pip install --require-hashes`: PENDING
- Diff from release lockfile: PENDING
- Decision: PENDING
