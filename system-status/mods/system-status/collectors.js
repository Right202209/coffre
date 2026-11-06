import { parsePacket, MAX_OUTPUT } from "./protocol.js";
import { deriveSample } from "./metrics.js";
// Fixed scripts; no cwd, machine name or process name is interpolated into a shell.
const envelope = `export LC_ALL=C
emit() { printf '%s ' "$1"; head -c 65536 | od -An -v -tx1 | tr -d ' \\n'; printf '\\n'; }
{ printf 'HERDR_STATUS_V1\\n'
`;
export const SYSTEM_SCRIPT = envelope + `
p=$(uname -s) || exit 1
printf '%s' "$p" | emit platform
uname -r | emit kernel
case "$p" in
Linux)
  cat /proc/sys/kernel/random/boot_id | emit boot
  cat /proc/uptime | emit time0
  cat /proc/stat | emit cpu0
  cat /proc/net/dev | emit net0
  sleep 1
  cat /proc/stat | emit cpu1
  cat /proc/net/dev | emit net1
  cat /proc/uptime | emit time1
  cat /proc/meminfo | emit memory
  cat /proc/loadavg | emit load
  cat /etc/os-release | emit os
  cat /proc/self/mountinfo | emit mounts
  ps -e -o pid=,rss=,comm= --sort=-rss | head -n 5 | emit processes
  ;;
Darwin)
  date +%s | emit time0
  netstat -ibn | emit net0
  top -l 2 -s 1 -n 0 | emit top
  netstat -ibn | emit net1
  date +%s | emit time1
  sysctl -n hw.memsize | emit memory
  sysctl -n hw.logicalcpu | emit cores
  sysctl -n vm.loadavg | emit load
  sysctl -n kern.boottime | emit boot
  sw_vers -productVersion | emit os
  ps -axo pid=,rss=,comm= | sort -k2,2nr | head -n 5 | emit processes
  ;;
esac
printf 'END\\n'; } | head -c 1048576`;
// A separate short exec avoids long disk scripts and Dropbear command length issues.
export const DISK_SCRIPT = envelope + `
p=$(uname -s) || exit 1
printf '%s' "$p" | emit platform
case "$p" in
Linux) cat /proc/sys/kernel/random/boot_id | emit boot; df -PTkl | emit disk ;;
Darwin) sysctl -n kern.boottime | emit boot; df -Pk / | emit disk ;;
esac
printf 'END\\n'; } | head -c 1048576`;
export function execArguments(machine, script) {
  return ["exec", "--json", "--timeout", "10", ...(machine == null ? [] : ["--on", machine]), "--", "sh", "-c", script];
}
async function command(hc, machine, script) {
  const r = await hc(execArguments(machine, script));
  if (r.code !== 0) throw new Error(`Remote exec failed (${r.code})`);
  if (r.stdout.length > Math.ceil(MAX_OUTPUT * 4 / 3) + 4096) throw new Error("Status output exceeds 1 MiB");
  let value;
  try { value = JSON.parse(r.stdout); } catch { throw new Error("Invalid herdr-core exec response"); }
  const result = value.result ?? value;
  if (result.error || result.code !== 0 || result.timed_out || result.truncated || typeof result.stdout !== "string")
    throw new Error("System command unavailable, truncated or timed out");
  // The core protocol carries output as base64. Accept decoded CLI output as well.
  return parsePacket(result.stdout.startsWith("HERDR_STATUS_V1\n") ? result.stdout : decodeOutput(result.stdout));
}
export function decodeOutput(encoded) {
  if (encoded.length > Math.ceil(MAX_OUTPUT * 4 / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new Error("Invalid base64 status output");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < encoded.length; i += 4) {
    const a = alphabet.indexOf(encoded[i]), b = alphabet.indexOf(encoded[i + 1]);
    const c = alphabet.indexOf(encoded[i + 2]), d = alphabet.indexOf(encoded[i + 3]);
    const bytes = [(a << 2) | (b >> 4)];
    if (c >= 0) bytes.push(((b & 15) << 4) | (c >> 2));
    if (d >= 0) bytes.push(((c & 3) << 6) | d);
    if (bytes.some(byte => byte > 127)) throw new Error("Non-ASCII status envelope");
    output += String.fromCharCode(...bytes);
  }
  if (output.length > MAX_OUTPUT) throw new Error("Status output exceeds 1 MiB");
  return output;
}
export async function collect(hc, machine, first, now = Date.now) {
  const started = now();
  const readings = await Promise.allSettled([command(hc, machine, SYSTEM_SCRIPT), command(hc, machine, DISK_SCRIPT)]);
  if (readings[0].status === "rejected") throw readings[0].reason;
  const sections = { ...readings[0].value };
  if (readings[1].status === "fulfilled" && readings[1].value.platform === sections.platform
    && readings[1].value.boot === sections.boot) sections.disk = readings[1].value.disk;
  const sample = deriveSample(sections, now(), now() - started, first);
  if (!sample.unsupported && !sample.disk) sample.diskError = true;
  return sample;
}
