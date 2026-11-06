"""Add one SFTP launcher above Settings in the active personal layout."""

import json
import os
from pathlib import Path
import subprocess
import time

app = Path(os.environ.get("HERDR_APP_HOME", str(Path.home() / ".config/herdr-app")))
status = json.loads(subprocess.check_output(["herdr-app", "status"], text=True))
name = status["layout"]
if name in ("main", "terminals", "win98"):
    raise SystemExit("Duplicate the shipped layout before adding a launcher; the mod can already open with mod.open.")
path = app / "layouts" / f"{name}.json"
original = path.read_text()
layout = json.loads(original)


def insert(node):
    children = node.get("children", [])
    if any(c.get("id") == "sftp-launcher" for c in children):
        return True
    for index, child in enumerate(children):
        if child.get("id") == "sidebar-footer":
            children.insert(index, {"id": "sftp-launcher", "type": "block", "size": {"px": 28},
                                    "content": {"mod": "sftp", "props": {"launcher": True}}})
            return True
        if insert(child):
            return True
    return False


if not insert(layout):
    raise SystemExit("No sidebar-footer found. Add the launcher block to your layout manually.")
backup = app / "data" / "sftp" / f"{name}.json.backup-{time.time_ns()}"
backup.parent.mkdir(parents=True, exist_ok=True)
backup.write_text(original)
temporary = path.with_suffix(".json.sftp-tmp")
temporary.write_text(json.dumps(layout, ensure_ascii=False, indent=2) + "\n")
if path.read_text() != original:
    temporary.unlink()
    raise SystemExit("Layout changed while installing; retry.")
os.replace(temporary, path)
print(f"SFTP launcher added to {name}. Backup: {backup}")
