// ASCII envelope: UTF-8 payloads are hex encoded, never split on payload delimiters.
export const MAX_OUTPUT = 1024 * 1024;
export const MAX_SECTION = 65536;
const keys = new Set(["platform", "cpu0", "cpu1", "memory", "net0", "net1", "time0", "time1",
  "load", "boot", "os", "kernel", "cores", "top", "processes", "mounts", "disk"]);
function utf8(hex) {
  // Herdr does not promise TextDecoder. decodeURIComponent validates UTF-8 strictly.
  try { return decodeURIComponent(hex.replace(/../g, b => `%${b}`)); }
  catch { throw new Error("Invalid UTF-8 in status protocol"); }
}
export function parsePacket(text) {
  if (typeof text !== "string" || text.length > MAX_OUTPUT) throw new Error("Status output exceeds 1 MiB");
  const lines = text.trimEnd().split("\n");
  if (lines.shift() !== "HERDR_STATUS_V1" || lines.pop() !== "END") throw new Error("Incomplete or unsupported status protocol");
  const sections = Object.create(null);
  for (const line of lines) {
    const m = /^([a-z0-9]+) ([0-9a-f]*)$/.exec(line);
    if (!m || !keys.has(m[1]) || Object.hasOwn(sections, m[1]) || m[2].length % 2 || m[2].length > MAX_SECTION * 2)
      throw new Error("Invalid status section");
    sections[m[1]] = utf8(m[2]);
  }
  return sections;
}
