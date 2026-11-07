import { joinPath, parentPath } from "./files.js";

export const TREE_LIMIT = 5000;
export const TREE_DEPTH = 32;

// Paths identify the visible directory entries, including entries reached
// through symlinks. Canonical paths are used only to detect ancestor cycles.
export class FileTree {
  constructor() {
    this.path = ""; this.entries = []; this.branches = new Map(); this.expanded = new Set();
  }
  reset(result) {
    if (this.path !== result.path) this.expanded.clear();
    this.path = result.path; this.entries = result.entries;
    this.branches.clear(); this.limited = result.limited;
  }
  entry(path) {
    if (path === this.path && path) return { path, name: path, directory: true, kind: "d", root: true };
    return this.entries.find(entry => entry.path === path)
      ?? [...this.branches.values()].flatMap(branch => branch.entries).find(entry => entry.path === path);
  }
  setChildren(path, result) {
    let ancestor = parentPath(path), cycle = result.path === this.path;
    while (!cycle && ancestor !== this.path && ancestor !== "/") {
      cycle = this.branches.get(ancestor)?.canonical === result.path;
      ancestor = parentPath(ancestor);
    }
    this.branches.set(path, { canonical: result.path, loading: false, limited: result.limited,
      error: cycle ? "symlink-cycle" : "", entries: cycle ? [] : result.entries.map(entry => ({ ...entry, path: joinPath(path, entry.name) })) });
  }
  rows(showHidden) {
    const rows = [];
    const message = (parent, depth, code) => rows.push({ path: `${parent}\0${code}`, parent, depth, message: code });
    const visit = (entries, depth) => {
      for (const entry of entries) {
        if (rows.length >= TREE_LIMIT) break;
        if (!showHidden && entry.name.startsWith(".")) continue;
        const expanded = entry.directory && this.expanded.has(entry.path);
        rows.push({ ...entry, depth, expanded });
        if (!expanded) continue;
        const branch = this.branches.get(entry.path);
        if (depth >= TREE_DEPTH) message(entry.path, depth + 1, "tree-depth");
        else if (!branch || branch.loading) message(entry.path, depth + 1, "loading");
        else if (branch.error) message(entry.path, depth + 1, branch.error);
        else {
          const before = rows.length;
          visit(branch.entries, depth + 1);
          if (before === rows.length) message(entry.path, depth + 1, "empty");
          if (branch.limited) message(entry.path, depth + 1, "limited");
        }
      }
    };
    visit(this.entries, 0);
    if (rows.length >= TREE_LIMIT) message(this.path, 0, "tree-limit");
    return rows;
  }
  canMove(source, destination) {
    const entry = this.entry(source), target = this.entry(destination);
    return Boolean(entry && !entry.root && entry.kind !== "o" && target?.directory
      && source !== destination && parentPath(source) !== destination
      && (!entry.directory || !destination.startsWith(`${source}/`)));
  }
}
