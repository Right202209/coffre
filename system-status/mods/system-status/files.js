import { decodeOutput } from "./collectors.js";
import { MAX_OUTPUT } from "./protocol.js";

export const FILE_LIMIT = 1000;
const HEADER = "HERDR_FILES_V1";
const shellHelpers = `export LC_ALL=C
hex() { od -An -v -tx1 | tr -d ' \\n'; }
fail() {
  printf 'ERROR %s ' "$1"
  printf '%s' "$2" | head -c 4096 | hex
  printf '\\nEND\\n'
  exit 0
}
printf 'HERDR_FILES_V1\\n'
platform=$(uname -s)
case "$platform" in Linux|Darwin) ;; *) fail unsupported ;; esac
`;

// All paths are positional arguments, never executable shell text. Names are
// hex-encoded so spaces, tabs, newlines and shell punctuation round-trip.
export const FILE_LIST_SCRIPT = shellHelpers + `
folder=$1
case "$folder" in
  ''|'~') folder=$HOME ;;
  '~/'*) folder=$HOME/\${folder#\\~/} ;;
  /*) ;;
  *) fail invalid-path ;;
esac
cd -P "$folder" 2>/dev/null || fail cannot-open
[ -r . ] && [ -x . ] || fail cannot-open
printf 'PATH '; printf '%s' "$PWD" | hex; printf '\\n'
count=0
limited=0
for name in .[!.]* ..?* *; do
  [ -e "$name" ] || [ -L "$name" ] || continue
  if [ "$count" -ge ${FILE_LIMIT} ]; then limited=1; break; fi
  kind=o
  if [ -L "$name" ]; then kind=l
  elif [ -d "$name" ]; then kind=d
  elif [ -f "$name" ]; then kind=f
  fi
  directory=0
  [ ! -d "$name" ] || directory=1
  case "$platform" in
    Linux) meta=$(stat -c '%s %Y' -- "./$name" 2>/dev/null) ;;
    Darwin) meta=$(stat -f '%z %m' "./$name" 2>/dev/null) ;;
  esac
  [ -n "$meta" ] || meta='- -'
  printf 'ENTRY %s %s %s ' "$kind" "$directory" "$meta"
  printf '%s' "$name" | hex; printf '\\n'
  count=$((count + 1))
done
printf 'LIMIT %s\\nEND\\n' "$limited"
`;

export const FILE_ACTION_SCRIPT = shellHelpers + `
action=$1
source=$2
destination=$3
base=$4
case "$action" in cp|mv) ;; *) fail invalid-action ;; esac
case "$source" in /*) ;; *) fail invalid-path ;; esac
case "$base" in /*) ;; *) fail invalid-path ;; esac
[ "$source" != / ] || fail invalid-path
[ -e "$source" ] || [ -L "$source" ] || fail source-missing
[ -f "$source" ] || [ -d "$source" ] || [ -L "$source" ] || fail special-file
case "$destination" in
  '') fail invalid-path ;;
  '~') destination=$HOME ;;
  '~/'*) destination=$HOME/\${destination#\\~/} ;;
  /*) ;;
  *) destination=$base/$destination ;;
esac
# Match cp/mv: an existing directory receives the source's basename.
if [ -d "$destination" ]; then destination=\${destination%/}/\${source##*/}; fi
name=\${destination##*/}
case "$name" in ''|.|..) fail invalid-path ;; esac
parent=\${destination%/*}
[ -n "$parent" ] || parent=/
cd -P "$parent" 2>/dev/null || fail cannot-open
destination=\${PWD%/}/$name
if [ -d "$source" ] && [ ! -L "$source" ]; then
  cd -P "$source" 2>/dev/null || fail cannot-open
  case "$destination" in "$PWD"|"$PWD"/*) fail inside-source ;; esac
fi
[ ! -e "$destination" ] && [ ! -L "$destination" ] || fail destination-exists
# -n also refuses overwriting if a file appears after the existence check.
# GNU -T prevents treating a newly created destination as a container.
if [ "$platform" = Linux ]; then
  if [ "$action" = cp ]; then message=$(cp -R -P -n -T -- "$source" "$destination" 2>&1)
  else message=$(mv -n -T -- "$source" "$destination" 2>&1); fi
else
  if [ "$action" = cp ]; then message=$(cp -R -P -n "$source" "$destination" 2>&1)
  else message=$(mv -n "$source" "$destination" 2>&1); fi
fi
code=$?
[ "$code" -eq 0 ] || fail command-failed "$message"
if [ "$action" = mv ] && { [ -e "$source" ] || [ -L "$source" ]; }; then fail destination-exists; fi
printf 'DONE '; printf '%s' "$destination" | hex; printf '\\nEND\\n'
`;

export class FileError extends Error {
  constructor(code, detail = "") { super(detail || code); this.code = code; }
}

function decodeHex(value) {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) throw new FileError("invalid-response");
  try { return decodeURIComponent(value.replace(/../g, b => `%${b}`)); }
  catch { throw new FileError("invalid-name"); }
}

export function joinPath(folder, name) { return `${folder === "/" ? "" : folder}/${name}`; }
export function parentPath(folder) { return folder.slice(0, folder.lastIndexOf("/")) || "/"; }
export function browsePath(value, folder) {
  if (!value || value.includes("\0")) throw new FileError("invalid-path");
  return value.startsWith("/") || value === "~" || value.startsWith("~/") ? value : joinPath(folder, value);
}

export function parseFilePacket(output) {
  if (typeof output !== "string" || output.length > MAX_OUTPUT) throw new FileError("invalid-response");
  const lines = output.trimEnd().split("\n");
  if (lines.shift() !== HEADER || lines.pop() !== "END") throw new FileError("invalid-response");
  if (lines.length === 1 && lines[0].startsWith("ERROR ")) {
    const match = /^ERROR ([a-z-]+) ([0-9a-f]*)$/.exec(lines[0]);
    if (!match) throw new FileError("invalid-response");
    throw new FileError(match[1], decodeHex(match[2]));
  }
  if (lines.length === 1 && lines[0].startsWith("DONE ")) {
    const destination = decodeHex(lines[0].slice(5));
    if (!destination.startsWith("/") || destination.includes("\0")) throw new FileError("invalid-response");
    return { destination };
  }
  const pathLine = lines.shift(), limitLine = lines.pop();
  if (!pathLine?.startsWith("PATH ") || !/^LIMIT [01]$/.test(limitLine ?? "") || lines.length > FILE_LIMIT)
    throw new FileError("invalid-response");
  const path = decodeHex(pathLine.slice(5)), names = new Set();
  if (!path.startsWith("/") || path.includes("\0")) throw new FileError("invalid-response");
  const entries = lines.map(line => {
    const match = /^ENTRY ([dflo]) ([01]) (\d+|-) (-?\d+|-) ([0-9a-f]+)$/.exec(line);
    if (!match) throw new FileError("invalid-response");
    const name = decodeHex(match[5]);
    if (name === "." || name === ".." || /[\/\0]/.test(name) || names.has(name)) throw new FileError("invalid-response");
    names.add(name);
    const size = Number(match[3]), modified = Number(match[4]) * 1000;
    return { name, path: joinPath(path, name), kind: match[1], directory: match[2] === "1",
      size: Number.isSafeInteger(size) && size >= 0 ? size : null,
      modified: Number.isSafeInteger(modified) && Math.abs(modified) <= 8640000000000000 ? modified : null };
  });
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { path, entries, limited: limitLine === "LIMIT 1" };
}

async function request(hc, machine, script, args) {
  if (args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new FileError("invalid-path");
  const response = await hc(["exec", "--json", "--timeout", "30", ...(machine == null ? [] : ["--on", machine]),
    "--", "sh", "-c", script, "herdr-system-files", ...args]);
  if (response.code !== 0) throw new FileError("exec-failed");
  if (typeof response.stdout !== "string" || response.stdout.length > Math.ceil(MAX_OUTPUT * 4 / 3) + 8192)
    throw new FileError("too-large");
  let result;
  try { const value = JSON.parse(response.stdout); result = value.result ?? value; }
  catch { throw new FileError("invalid-response"); }
  if (result.timed_out) throw new FileError("timeout");
  if (result.truncated) throw new FileError("too-large");
  if (result.error || result.code !== 0 || typeof result.stdout !== "string") throw new FileError("exec-failed");
  let output;
  try { output = result.stdout.startsWith(`${HEADER}\n`) ? result.stdout : decodeOutput(result.stdout); }
  catch { throw new FileError("invalid-response"); }
  return parseFilePacket(output);
}

export async function listFiles(hc, machine, path) {
  const result = await request(hc, machine, FILE_LIST_SCRIPT, [path]);
  if (!("entries" in result)) throw new FileError("invalid-response");
  return result;
}
export async function operateFile(hc, machine, action, source, destination, base) {
  if (!["cp", "mv"].includes(action)) throw new FileError("invalid-action");
  const result = await request(hc, machine, FILE_ACTION_SCRIPT, [action, source, destination, base]);
  if (!("destination" in result)) throw new FileError("invalid-response");
  return result.destination;
}
