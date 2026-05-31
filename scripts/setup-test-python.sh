#!/usr/bin/env bash
# Create the uv-managed venvs used by the integration tests:
#   - python/              the main kernel env (ipykernel + libraries the tests
#                          exercise: matplotlib, plotly, etc.).
#   - python-unregistered/ a second ipykernel-only env that no test registers
#                          with the Python extension itself — the step-2 kernel
#                          test uses it to prove notebook_select_kernel can make
#                          a never-before-seen interpreter usable on its own.
# The Jupyter extension picks an env up as a kernel via its interpreter path; no
# global Jupyter kernelspec registration. Idempotent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/../test/fixtures"

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is not installed. See https://docs.astral.sh/uv/" >&2
  exit 1
fi

for env in python python-unregistered; do
  echo "==> uv sync ($env)"
  (cd "$FIXTURES_DIR/$env" && uv sync --quiet)
done

echo "ok"
