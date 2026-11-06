export const CONNECTIONS_KEY = "sftp.connections.v1";

export function connectionFrom(values) {
  const target = values.target.trim();
  const user = values.user.trim();
  const port = values.port.trim();
  if (!/^[A-Za-z0-9_@.:[\]%-]+$/.test(target) || target.startsWith("-"))
    throw new Error("请输入 SSH 别名、主机地址或 user@host");
  if (user && !/^[A-Za-z0-9_.-]+$/.test(user)) throw new Error("SSH 用户名无效");
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))
    throw new Error("端口必须在 1–65535 之间");
  return { name: values.name.trim() || target, target, user, port, key: values.key.trim(), path: values.path.trim() || "." };
}

export function machineConnections(machines) {
  return machines.filter(m => !m.temporary && m.target).map(m => ({
    id: `machine:${m.name}`, name: m.name, target: m.target,
    state: m.state, source: "machine", path: ".", user: "", port: "", key: "",
  }));
}

export function joinPath(parent, name) {
  return `${parent === "/" ? "" : parent.replace(/\/$/, "")}/${name}`;
}

export function parentPath(path) {
  return path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
}

export function visibleEntries(entries, filter, hidden, sort = "name", descending = false) {
  const query = filter.toLocaleLowerCase();
  return entries.filter(e => (hidden || !e.name.startsWith(".")) && e.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.directory) - Number(a.directory) ||
      (descending ? -1 : 1) * (sort === "name" ? a.name.localeCompare(b.name) : a[sort] - b[sort]) || a.name.localeCompare(b.name));
}

export function sizeLabel(size) {
  if (size < 1024) return `${size} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = size / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

export function makeTransfer(side, file, localPath, remotePath, connection) {
  if (!file.regular || file.link) throw new Error("请选择普通文件；双击文件夹进入");
  if (!connection || !localPath || !remotePath) throw new Error("请先连接远程机器并打开目标文件夹");
  return {
    op: side === "local" ? "upload" : "download",
    source: joinPath(side === "local" ? localPath : remotePath, file.name),
    destination: joinPath(side === "local" ? remotePath : localPath, file.name),
    connection: { ...connection },
  };
}
