#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
app_dir=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
mod_dir="$app_dir/mods/sftp"
if [[ -d "$mod_dir" && ! -f "$mod_dir/.herdr-sftp-owned" ]]; then
  echo "Refusing to overwrite an existing sftp mod: $mod_dir" >&2
  exit 1
fi
mkdir -p "$mod_dir"
touch "$mod_dir/.herdr-sftp-owned"
cp "$source_dir"/mods/sftp/*.js "$source_dir"/mods/sftp/*.py "$source_dir"/mods/sftp/*.svg "$source_dir"/mods/sftp/mod.json "$mod_dir/"
if command -v uv >/dev/null 2>&1; then
  if [[ ! -x "$mod_dir/.venv/bin/python" ]]; then uv venv "$mod_dir/.venv"; fi
  uv pip install --python "$mod_dir/.venv/bin/python" -r "$source_dir/requirements.txt"
else
  if [[ ! -x "$mod_dir/.venv/bin/python" ]]; then python3 -m venv "$mod_dir/.venv"; fi
  "$mod_dir/.venv/bin/python" -m pip install -r "$source_dir/requirements.txt"
fi
herdr-app check "$mod_dir"
echo 'Installed. Open with: herdr-app do mod.open --name sftp'
