#!/usr/bin/env bash
# Create the uv-managed venv used by the integration tests. The venv contains
# ipykernel + libraries the tests exercise; the Jupyter extension picks it up
# as a kernel via the Python interpreter path set in the test workspace's
# .vscode/settings.json. No global Jupyter kernelspec registration. Idempotent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY_DIR="$SCRIPT_DIR/../test/fixtures/python"

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is not installed. See https://docs.astral.sh/uv/" >&2
  exit 1
fi

cd "$PY_DIR"

echo "==> uv sync"
uv sync --quiet

echo "ok"
