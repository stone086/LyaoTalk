#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
mkdir -p artifacts/sbom

if command -v cyclonedx-py >/dev/null 2>&1; then
  cyclonedx-py requirements -i apps/api/requirements.txt -o artifacts/sbom/sbom-python.json
else
  echo "cyclonedx-py not found; install with: pip install cyclonedx-bom" >&2
fi

if command -v npx >/dev/null 2>&1; then
  (cd apps/web && npx --yes @cyclonedx/cyclonedx-npm --output-file ../../artifacts/sbom/sbom-node.json)
else
  echo "npx not found; install Node.js 20 LTS first" >&2
fi

echo "SBOM output directory: artifacts/sbom"
