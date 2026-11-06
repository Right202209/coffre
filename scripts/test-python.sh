#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
python_bin=${HERDR_MODS_PYTHON:-"$repo_dir/sftp/.venv/bin/python"}
if [[ -z "${HERDR_MODS_PYTHON:-}" && ! -x "$python_bin" ]]; then
  python_bin=python3
fi
if ! "$python_bin" -c 'import paramiko' >/dev/null 2>&1; then
  cat >&2 <<'HELP'
Python with Paramiko is required for the SFTP tests. From the repository root:
  python3 -m venv sftp/.venv
  sftp/.venv/bin/python -m pip install -r sftp/requirements.txt
Or set HERDR_MODS_PYTHON to an existing Python executable with Paramiko.
HELP
  exit 1
fi
exec "$python_bin" -m unittest discover -s "$repo_dir/sftp/tests" -p 'test_*.py' -v
