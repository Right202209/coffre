// Pure defensive decoders: no IO, terminal screen scraping or credentials.
export const valid = n => Number.isFinite(n) && n >= 0;
export const clamp = n => Math.max(0, Math.min(100, n));
const counter = n => Number.isSafeInteger(n) && n >= 0;
const numeric = text => text?.trim() ? Number(text.trim().split(/\s+/)[0]) : NaN;

export function parseCpu(text) {
  const rows = Object.create(null);
  for (const line of text?.split("\n") ?? []) {
    const m = /^(cpu\d*)\s+(.+)$/.exec(line);
    if (!m) continue;
    // guest and guest_nice are already included in user and nice.
    const ticks = m[2].trim().split(/\s+/).slice(0, 8).map(Number);
    const total = ticks.reduce((a, b) => a + b, 0);
    if (ticks.length >= 4 && ticks.every(counter) && counter(total))
      rows[m[1]] = { total, idle: ticks[3] + (ticks[4] ?? 0), ticks };
  }
  return rows.cpu ? rows : null;
}
export function cpuUsage(before, now) {
  if (!before || !now) return null;
  if (before.ticks && now.ticks && (before.ticks.length !== now.ticks.length || now.ticks.some((v, i) => v < before.ticks[i]))) return null;
  const total = now.total - before.total, idle = now.idle - before.idle;
  return total > 0 && idle >= 0 && idle <= total ? clamp(100 * (1 - idle / total)) : null;
}
export function parseMemory(text) {
  const v = Object.create(null);
  for (const line of text?.split("\n") ?? []) {
    const m = /^(\w+):\s+(\d+)\s+kB\s*$/.exec(line);
    if (m) v[m[1]] = Number(m[2]) * 1024;
  }
  if (!(v.MemTotal > 0) || !counter(v.MemTotal)) return null;
  // Preserve the previous mod's cache-aware estimate on kernels predating MemAvailable.
  const estimate = v.MemAvailable == null && counter(v.MemFree)
    ? v.MemFree + (v.Buffers ?? 0) + (v.Cached ?? 0) + (v.SReclaimable ?? 0) - (v.Shmem ?? 0) : v.MemAvailable;
  const available = valid(estimate) && estimate <= v.MemTotal ? estimate : null;
  const swapTotal = valid(v.SwapTotal) ? v.SwapTotal : null;
  const swapUsed = swapTotal != null && valid(v.SwapFree) && v.SwapFree <= swapTotal ? swapTotal - v.SwapFree : null;
  return { total: v.MemTotal, available, used: available == null ? null : v.MemTotal - available,
    percent: available == null ? null : (v.MemTotal - available) / v.MemTotal * 100, swapTotal, swapUsed };
}
export function parseNetwork(text) {
  if (!text?.includes("Receive") || !text.includes("Transmit")) return null;
  const result = Object.create(null);
  for (const line of text.split("\n")) {
    const m = /^\s*([^:\s]+):\s*(.+)$/.exec(line);
    if (!m || m[1] === "lo") continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length >= 16 && counter(f[0]) && counter(f[8])) result[m[1]] = { rx: f[0], tx: f[8] };
  }
  return result;
}
export function networkRates(before, now, elapsedMs) {
  if (!before || !now || !(elapsedMs > 0) || elapsedMs > 10000) return null;
  const interfaces = [];
  for (const [name, c] of Object.entries(now)) {
    const p = before[name], usable = p && c.rx >= p.rx && c.tx >= p.tx;
    interfaces.push({ name, rx: usable ? (c.rx - p.rx) * 1000 / elapsedMs : null,
      tx: usable ? (c.tx - p.tx) * 1000 / elapsedMs : null });
  }
  const measured = interfaces.filter(i => i.rx != null);
  return { rx: measured.length ? measured.reduce((s, i) => s + i.rx, 0) : null,
    tx: measured.length ? measured.reduce((s, i) => s + i.tx, 0) : null, interfaces };
}
export function parseMacNetwork(text) {
  const lines = text?.trim().split("\n") ?? [], head = lines.shift()?.trim().split(/\s+/) ?? [];
  const rx = head.indexOf("Ibytes"), tx = head.indexOf("Obytes");
  if (rx < 0 || tx < 0) return null;
  const result = Object.create(null);
  for (const line of lines) {
    const f = line.trim().split(/\s+/), name = f[0]?.replace(/\*$/, "");
    if (!name || name === "lo0" || !f[2]?.startsWith("<Link#")) continue;
    const r = Number(f[rx]), t = Number(f[tx]);
    if (counter(r) && counter(t)) result[name] = { rx: r, tx: t };
  }
  return result;
}
const unescapeMount = s => s.replace(/\\(040|011|012|134)/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
const remote = /^(nfs\d*|cifs|smbfs|smb3|sshfs|fuse\..*|9p|ceph|glusterfs|afs)$/i;
const local = /^(ext[234]|xfs|btrfs|zfs|ufs|apfs|hfs|hfsplus|f2fs|vfat|exfat|ntfs|ntfs3)$/i;
export function parseDisks(text, mountText, platform) {
  const mounts = new Map();
  for (const line of mountText?.split("\n") ?? []) {
    const [left, right] = line.split(" - "), f = left.split(" "), r = right?.split(" ");
    if (f.length >= 6 && r) mounts.set(unescapeMount(f[4]), { device: f[2], root: unescapeMount(f[3]), fs: r[0] });
  }
  const rows = [];
  for (const line of text?.split("\n") ?? []) {
    const m = platform === "Linux"
      ? /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\/.*)$/.exec(line)
      : /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\/.*)$/.exec(line);
    if (!m) continue;
    const offset = platform === "Linux" ? 1 : 0, mount = m[6 + offset];
    const total = Number(m[2 + offset]) * 1024, used = Number(m[3 + offset]) * 1024, available = Number(m[4 + offset]) * 1024;
    const info = mounts.get(mount), fs = info?.fs ?? (platform === "Linux" ? m[2] : "apfs");
    if (!total || ![total, used, available].every(counter) || used > total || remote.test(fs)) continue;
    if (platform === "Linux" && mount !== "/" && (!info || info.root !== "/" || !local.test(fs))) continue;
    rows.push({ device: m[1], key: info?.device ?? m[1], fs, mount, total, used, available,
      percent: clamp(Number(m[5 + offset])) });
  }
  // APFS/ZFS/Btrfs may share capacity. Root scope avoids summing a shared pool.
  const rootOnly = platform === "Darwin" || rows.some(r => /^(btrfs|zfs)$/.test(r.fs));
  const candidates = rootOnly ? rows.filter(r => r.mount === "/") : rows;
  const seen = new Set(), disks = [];
  for (const d of candidates.sort((a, b) => Number(b.mount === "/") - Number(a.mount === "/"))) {
    if (seen.has(d.key)) continue;
    seen.add(d.key); disks.push(d);
  }
  if (!disks.length) return null;
  const total = disks.reduce((s, d) => s + d.total, 0), used = disks.reduce((s, d) => s + d.used, 0);
  const available = disks.reduce((s, d) => s + d.available, 0);
  return { total, used, available, percent: used / (used + available) * 100,
    scope: rootOnly || disks.every(d => d.mount === "/") ? "root" : "local", disks };
}
export function parseProcesses(text, totalMemory) {
  const rows = [];
  for (const line of text?.split("\n") ?? []) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]), rss = Number(m[2]) * 1024;
    if (pid > 0 && counter(rss)) rows.push({ pid, rss, name: m[3], percent: totalMemory > 0 ? clamp(rss / totalMemory * 100) : null });
  }
  return rows.sort((a, b) => b.rss - a.rss).slice(0, 5);
}
export function deriveSample(sections, at, responseMs, first = false) {
  const platform = sections.platform?.trim();
  if (!["Linux", "Darwin"].includes(platform)) return { unsupported: true, platform: platform ?? "unknown" };
  const linux = platform === "Linux", a = parseCpu(sections.cpu0), b = parseCpu(sections.cpu1);
  const uptime0 = numeric(sections.time0), uptime1 = numeric(sections.time1), elapsed = (uptime1 - uptime0) * 1000;
  const cores = b ? Object.keys(b).filter(k => k !== "cpu") : [];
  const macCpu = [...(sections.top?.matchAll(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/g) ?? [])].pop();
  const coreCountChanged = a && b && Object.keys(a).length !== Object.keys(b).length;
  const macCount = numeric(sections.cores);
  const cpu = { percent: first ? null : linux ? coreCountChanged ? null : cpuUsage(a?.cpu, b?.cpu) : macCpu ? clamp(Number(macCpu[1]) + Number(macCpu[2])) : null,
    count: linux ? cores.length : valid(macCount) ? macCount : null,
    cores: cores.slice(0, 12).map(name => ({ name, percent: first ? null : cpuUsage(a?.[name], b[name]) })) };
  const memory = linux ? parseMemory(sections.memory) : (() => {
    const total = numeric(sections.memory);
    // Darwin has no MemAvailable equivalent in these sources. Do not invent a percentage.
    return total > 0 && counter(total) ? { total, used: null, available: null, percent: null, swapTotal: null, swapUsed: null } : null;
  })();
  const network = networkRates(first ? null : linux ? parseNetwork(sections.net0) : parseMacNetwork(sections.net0),
    linux ? parseNetwork(sections.net1) : parseMacNetwork(sections.net1), elapsed);
  const load = linux ? numeric(sections.load) : numeric(sections.load?.replace(/[{}]/g, ""));
  let uptime = linux && valid(uptime1) ? uptime1 : null;
  if (!linux) {
    const boot = /sec\s*=\s*(\d+)/.exec(sections.boot ?? ""), seconds = numeric(sections.time1);
    if (boot && valid(seconds) && seconds >= Number(boot[1])) uptime = seconds - Number(boot[1]);
  }
  const os = linux ? /^PRETTY_NAME=["']?(.*?)["']?$/m.exec(sections.os ?? "")?.[1] ?? "Linux" : sections.os?.trim() || "macOS";
  const disks = parseDisks(sections.disk, sections.mounts, platform);
  if (!b && !memory && !network && !disks && !macCpu) throw new Error("no-data");
  return { at, platform, cpu, memory, network, disk: disks, load: valid(load) ? load : null, uptime,
    os, kernel: sections.kernel?.trim() || null, responseMs, processes: parseProcesses(sections.processes, memory?.total),
    partial: !memory || memory.percent == null || !disks || (!first && (cpu.percent == null || network?.rx == null)) };
}
export function formatBytes(bytes) {
  if (!valid(bytes)) return "--";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const u = bytes === 0 ? 0 : Math.max(0, Math.min(5, Math.floor(Math.log2(bytes) / 10)));
  return `${(bytes / 1024 ** u).toFixed(u && bytes / 1024 ** u < 10 ? 1 : 0)} ${units[u]}`;
}
export const percentage = n => valid(n) ? `${n.toFixed(1)}%` : "--";
export function formatUptime(seconds) {
  if (!valid(seconds)) return "--";
  const m = Math.floor(seconds / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return `${d ? `${d}d ` : ""}${h % 24}h ${m % 60}m`;
}
