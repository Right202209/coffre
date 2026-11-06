#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
command -v herdr-app >/dev/null 2>&1 || {
  echo 'herdr-app is required. Install Herdr and add its CLI to PATH.' >&2
  exit 1
}

shopt -s nullglob
mod_dirs=("$repo_dir"/*/mods/*)
if ((${#mod_dirs[@]} == 0)); then
  echo 'No mod bundles found.' >&2
  exit 1
fi

failed=0
for mod_dir in "${mod_dirs[@]}"; do
  [[ -d "$mod_dir" ]] || continue
  bundle_dir=$(dirname -- "$(dirname -- "$mod_dir")")
  for required in "$bundle_dir/README.md" "$bundle_dir/RECIPE.md" "$bundle_dir/preview.png" "$mod_dir/main.js" "$mod_dir/mod.json"; do
    if [[ ! -s "$required" ]]; then
      printf 'Missing or empty bundle file: %s\n' "$required" >&2
      failed=1
    fi
  done
  printf '\nChecking %s\n' "${mod_dir#"$repo_dir/"}"
  if ! herdr-app check "$mod_dir"; then
    failed=1
  fi
done
exit "$failed"
