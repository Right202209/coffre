import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { hc, shared, setShared } from "herdr";
import { listFiles, operateFile, parentPath, browsePath } from "./files.js";
import { translations } from "./i18n.js";
import { FileTree, TREE_DEPTH } from "./file-tree.js";
import { faded } from "./ui.js";
import { ROW, PAD, unzoom, displayPath, shortcut, banner, treeHeader, treeRow, contextMenu } from "./file-view.js";

const BROWSER_STATE = "system-status.files.browser";
const browserKey = machine => machine == null ? BROWSER_STATE : `${BROWSER_STATE}.machine:${JSON.stringify(machine)}`;
const browsingFields = ["startPath", "path", "entries", "tree", "selected", "showHidden", "scrollOffset", "error", "notice", "limited", "loaded"];

function initialState(machine) {
  const saved = shared(browserKey(machine));
  return {
    startPath: typeof saved?.path === "string" && saved.path.startsWith("/") && !saved.path.includes("\0") ? saved.path : "~",
    path: "", entries: [], tree: new FileTree(), selected: null, showHidden: saved?.showHidden === true,
    scrollOffset: 0, error: "", notice: "", limited: false, loaded: false,
  };
}

export class FileBrowser {
  constructor(cx, language, getTarget = () => ({ machine: null, connection: "ready" })) {
    this.l = translations(language);
    this.getTarget = getTarget;
    const target = this.target();
    this.machine = target.machine; this.connection = target.connection; this.name = target.name;
    this.states = new Map(); this.jobs = new Map(); this.active = false;
    Object.assign(this, initialState(this.machine));
    this.pathInput = InputState.new({ placeholder: this.l.filePath, value: this.startPath });
    this.destinationInput = InputState.new({ placeholder: this.l.destination });
    this.listFocus = cx.focus_handle(); this.viewportHeight = 320; this.scrollPress = null;
    this.menuFocus = cx.focus_handle(); this.branchRequests = new Set();
    this.menu = null; this.press = null; this.dropTarget = null; this.suppressClickUntil = 0;
    this.handles = Object.fromEntries(["up", "home", "root", "go", "hidden", "path", "open", "copy", "move", "confirm", "cancel"]
      .map(key => [key, cx.focus_handle()]));
    this.generation = 0; this.closed = false; this.loading = false; this.working = false;
    this.operation = null;
    this.pathInput.on("submit", (_e, cx) => this.navigate(this.pathInput.value(), cx));
    this.destinationInput.on("submit", (_e, cx) => this.confirm(cx));
  }
  target() {
    const target = this.getTarget() ?? {}, machine = target.machine ?? null;
    return { machine, name: machine == null ? this.l.local : target.name || machine,
      connection: machine == null && target.connection === "no-session" ? "ready"
        : target.connection ?? (machine == null ? "ready" : "unavailable") };
  }
  sync(active, cx) {
    if (this.closed) return;
    this.active = active;
    const target = this.target();
    if (target.machine !== this.machine) {
      this.invalidateReads(); this.remember();
      this.states.set(this.machine, Object.fromEntries(browsingFields.map(key => [key, this[key]])));
      this.machine = target.machine;
      Object.assign(this, this.states.get(this.machine) ?? initialState(this.machine));
      this.working = this.jobs.has(this.machine);
      this.operation = this.menu = this.press = this.dropTarget = this.scrollPress = null;
      this.pathInput.set_value(this.path || this.startPath); this.destinationInput.set_value("");
      this.connection = target.connection; cx.notify();
    } else if (target.connection !== this.connection) {
      this.invalidateReads(); this.loaded = false;
      this.operation = this.menu = this.press = this.dropTarget = this.scrollPress = null;
      this.connection = target.connection; cx.notify();
    }
    this.name = target.name;
    if (!active && (this.press || this.menu || this.scrollPress)) { this.press = this.menu = this.dropTarget = this.scrollPress = null; cx.notify(); }
    if (active && !this.loaded && !this.loading) this.load(this.path || this.startPath, cx, true);
    if (active) this.pumpBranches(cx);
  }
  available() {
    const target = this.target();
    // Consult live context too: focus may have changed before sync or a queued click.
    return !this.closed && this.connection === "ready" && target.connection === "ready" && target.machine === this.machine;
  }
  invalidateReads() {
    this.generation++;
    if (this.loading) this.loaded = false;
    this.loading = false; this.branchRequests.clear();
    for (const [folder, branch] of this.tree.branches) if (branch.loading) this.tree.branches.delete(folder);
  }
  remember() {
    setShared(browserKey(this.machine), { path: this.path || this.startPath, showHidden: this.showHidden });
  }
  currentEntry() { return this.tree.entry(this.selected); }
  visibleEntries() { return this.tree.rows(this.showHidden).filter(row => !row.message); }
  failure(error) { return this.l.fileErrors[error?.code] ?? this.l.fileFailed; }
  load(path, cx, keepNotice = false) {
    if (!this.available() || this.working || this.loading) return;
    // A failed navigation keeps the old tree. Let its interrupted expansions
    // retry under the new generation instead of leaving permanent spinners.
    this.invalidateReads();
    const generation = this.generation, machine = this.machine;
    this.loading = true; this.error = ""; this.operation = null;
    this.menu = this.press = this.dropTarget = null;
    if (!keepNotice) this.notice = "";
    cx.spawn(async cx => {
      try {
        const result = await listFiles(hc, machine, path);
        if (!this.valid(generation)) return;
        const changed = this.path !== result.path;
        this.tree.reset(result);
        this.path = result.path; this.entries = result.entries; this.limited = result.limited;
        this.pathInput.set_value(result.path);
        if (changed || !this.currentEntry()) this.selected = null;
        if (changed) this.scrollOffset = 0;
        this.remember();
      } catch (error) {
        if (this.valid(generation)) {
          this.error = this.failure(error);
          if (this.path) this.pathInput.set_value(this.path);
        }
      } finally {
        if (this.valid(generation)) { this.loaded = true; this.loading = false; this.pumpBranches(cx); cx.notify(); }
      }
    });
  }
  valid(generation) { return this.available() && this.generation === generation; }
  pumpBranches(cx) {
    if (!this.available() || !this.active || this.loading || this.working) return;
    for (const row of this.visibleEntries()) {
      if (this.branchRequests.size >= 3) break;
      if (!row.expanded || row.depth >= TREE_DEPTH || this.tree.branches.has(row.path)) continue;
      const token = {}, generation = this.generation, machine = this.machine;
      this.branchRequests.add(token);
      this.tree.branches.set(row.path, { entries: [], loading: true });
      cx.spawn(async cx => {
        try {
          const result = await listFiles(hc, machine, row.path);
          if (this.valid(generation)) this.tree.setChildren(row.path, result);
        } catch (error) {
          if (this.valid(generation)) this.tree.branches.set(row.path, { entries: [], error: error?.code || "exec-failed" });
        } finally {
          this.branchRequests.delete(token);
          if (this.valid(generation)) { this.pumpBranches(cx); cx.notify(); }
        }
      });
    }
  }
  toggle(path, cx) {
    if (!this.available() || this.loading || this.working || !this.tree.entry(path)?.directory || path === this.path) return;
    this.menu = null;
    if (this.tree.expanded.has(path)) {
      this.tree.expanded.delete(path);
      if (this.selected?.startsWith(`${path}/`)) this.selected = path;
    } else {
      this.tree.expanded.add(path);
      if (this.tree.branches.get(path)?.error) this.tree.branches.delete(path);
      this.pumpBranches(cx);
    }
    cx.notify();
  }
  navigate(value, cx) {
    if (!this.available() || this.working || this.loading) return;
    try { this.load(browsePath(value, this.path || "/"), cx); }
    catch (error) { this.error = this.failure(error); }
    cx.notify();
  }
  refresh(cx) { this.load(this.path || this.pathInput.value() || "~", cx); cx.notify(); }
  copyPath(cx) {
    if (!this.available() || !(this.selected || this.path)) return;
    cx.write_to_clipboard(this.selected || this.path); this.notice = this.l.copiedPath; cx.notify();
  }
  begin(action, cx) {
    const entry = this.currentEntry();
    if (!entry || entry.root || entry.kind === "o" || !this.available() || this.loading || this.working) return;
    this.menu = this.press = this.dropTarget = null;
    this.operation = { action, source: entry.path, base: parentPath(entry.path), root: this.path, machine: this.machine };
    this.destinationInput.set_value(entry.path);
    this.destinationInput.focus(); this.notice = ""; this.error = ""; cx.notify();
  }
  cancel(cx) {
    if (this.menu || this.press || this.scrollPress) {
      this.menu = this.press = this.dropTarget = this.scrollPress = null; this.listFocus.focus(); cx.notify(); return true;
    }
    if (!this.operation || this.working) return false;
    this.operation = null; this.error = ""; this.listFocus.focus(); cx.notify(); return true;
  }
  confirm(cx) {
    const operation = this.operation;
    if (!operation || this.working || !this.available() || operation.machine !== this.machine || this.jobs.has(this.machine)) return;
    const destination = this.destinationInput.value();
    if (!destination || destination.includes("\0")) { this.error = this.l.fileErrors["invalid-path"]; cx.notify(); return; }
    const machine = this.machine;
    this.jobs.set(machine, operation);
    this.working = true; this.error = ""; this.notice = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await operateFile(hc, machine, operation.action, operation.source, destination, operation.base);
        if (this.closed) return;
        const state = machine === this.machine ? this : this.states.get(machine);
        state.selected = null; state.loaded = false; state.error = "";
        state.notice = `${operation.action === "cp" ? this.l.fileCopied : this.l.fileMoved} ${displayPath(result)}`;
        if (state === this) this.operation = null;
      } catch (error) {
        if (!this.closed) {
          const state = machine === this.machine ? this : this.states.get(machine);
          // A reconnect must not immediately hide an operation error (which
          // may report a partial move). Leave the cached tree until refresh.
          state.error = this.failure(error); state.loaded = true;
        }
      } finally {
        this.jobs.delete(machine);
        if (!this.closed) {
          if (machine === this.machine) {
            this.working = false;
            if (this.active && this.available() && !this.loaded) this.load(operation.root, cx, true);
          }
          cx.notify();
        }
      }
    });
  }
  startPress(path, event, cx) {
    if (!this.available() || this.loading || this.working || this.operation) return;
    this.menu = null; this.selected = path; this.listFocus.focus();
    const entry = this.tree.entry(path);
    this.press = entry && !entry.root && entry.kind !== "o"
      ? { source: path, x: event.position.x, y: event.position.y, generation: this.generation, dragging: false } : null;
    this.dropTarget = null; cx.notify();
  }
  dragOver(path, event, cx) {
    if (!this.press || !this.available()) return;
    const wasDragging = this.press.dragging;
    this.press.dragging ||= Math.hypot(event.position.x - this.press.x, event.position.y - this.press.y) >= 5;
    const target = this.press.dragging && this.tree.canMove(this.press.source, path) ? path : null;
    if (wasDragging !== this.press.dragging || target !== this.dropTarget) { this.dropTarget = target; cx.notify(); }
  }
  drop(path, cx) {
    const press = this.press;
    this.press = this.dropTarget = this.scrollPress = null;
    if (!press?.dragging) return;
    this.suppressClickUntil = Date.now() + 350;
    if (this.valid(press.generation) && this.tree.canMove(press.source, path)) {
      this.selected = press.source;
      this.begin("mv", cx);
      if (this.operation) {
        if (path !== this.path) this.tree.expanded.add(path);
        this.destinationInput.set_value(path); this.confirm(cx);
      }
    }
    cx.notify();
  }
  openMenu(path, event, cx) {
    cx.stop_propagation();
    if (!this.available() || this.loading || this.working || this.operation || !this.tree.entry(path)) return;
    this.selected = path; this.press = this.dropTarget = null;
    const bounds = this.panelBounds;
    this.menu = { path, index: 0,
      x: bounds ? unzoom(event.position.x - bounds.x) : 8,
      y: bounds ? unzoom(event.position.y - bounds.y) : 60 };
    this.menuFocus.focus(); cx.notify();
  }
  menuItems() {
    const entry = this.tree.entry(this.menu?.path), l = this.l;
    if (!entry) return [];
    // Shortcuts mirror listKey; groups draw separators.
    return [
      { label: l.copyPath, action: "path", shortcut: shortcut("mod", "C"), group: 0 },
      ...(entry.directory && !entry.root ? [{ label: this.tree.expanded.has(entry.path) ? l.collapseFolder : l.expandFolder,
        action: "toggle", shortcut: "Enter", group: 1 }, { label: l.openFolder, action: "open", group: 1 }] : []),
      ...(!entry.root && entry.kind !== "o" ? [{ label: l.copyFile, action: "cp", group: 2 },
        { label: l.moveFile, action: "mv", shortcut: "F2", group: 2 }] : []),
      { label: l.refresh, action: "refresh", shortcut: "R", group: 3 },
    ];
  }
  chooseMenu(action, cx) {
    const path = this.menu?.path;
    this.menu = null; this.listFocus.focus();
    if (!this.available() || !this.tree.entry(path) || this.loading || this.working) { cx.notify(); return; }
    this.selected = path;
    if (action === "path") this.copyPath(cx);
    else if (action === "toggle") this.toggle(path, cx);
    else if (action === "open") this.navigate(path, cx);
    else if (action === "cp" || action === "mv") this.begin(action, cx);
    else if (action === "refresh") this.refresh(cx);
    cx.notify();
  }
  button(key, label, enabled, action, t, { icon = null, pressed = false, primary = false, compact = false } = {}) {
    const handle = this.handles[key], lit = pressed || handle.is_focused();
    const activate = (_event, cx) => { cx.stop_propagation(); if (enabled) action(cx); };
    return div().id(`files-${key}`).role("button").accessibility_label(label).tooltip(label)
      .track_focus(handle).tab_stop(enabled).disabled(!enabled).flex_none().rounded(5)
      .flex().items_center().justify_center().opacity(enabled ? 1 : 0.4)
      .when(Boolean(icon), el => el.size(compact ? 24 : 26).text_color(lit ? t.foreground : t.muted).bg(lit ? t.selected : "#00000000"))
      .when(!icon, el => el.h(28).px(11).border(1).border_color(primary ? t.solid : t.input)
        .bg(primary ? t.solid : lit ? t.selected : "#00000000").text_color(primary ? t.solid_foreground : t.foreground))
      .when(enabled, e => e.hover(el => primary ? el.opacity(0.85) : el.bg(lit ? t.selected : t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); handle.focus(); }))
      .on_click(activate).on_key_down((e, cx) => { if (["enter", "space"].includes(e.key)) activate(e, cx); })
      .child(icon ? svg(`mods/system-status/${icon}.svg`).size(14) : label);
  }
  input(state, id, t) {
    // Let the native input receive text events. Panel shortcuts check their
    // own focus handles, so typing here cannot trigger the refresh shortcut.
    return div().min_w(0).flex_1()
      .child(Input.new(state).id(id).h(28).w_full().min_w(0).px(8).rounded(5)
        .border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(11.5)
        .accessibility_label(id === "files-path-input" ? this.l.filePath : this.l.destination));
  }
  listKey(e, cx) {
    if (!this.available() || this.loading || this.working) return;
    const entries = this.visibleEntries(), index = entries.findIndex(entry => entry.path === this.selected);
    if (["up", "down", "home", "end"].includes(e.key) && entries.length) {
      const next = e.key === "home" ? 0 : e.key === "end" ? entries.length - 1
        : Math.max(0, Math.min(entries.length - 1, index + (e.key === "up" ? -1 : 1)));
      cx.stop_propagation(); this.selected = entries[next].path;
      this.scrollToItem(this.tree.rows(this.showHidden).findIndex(row => row.path === this.selected)); cx.notify();
    } else if (e.key === "enter" && this.currentEntry()?.directory) {
      cx.stop_propagation(); this.toggle(this.selected, cx);
    } else if (e.key === "right" && this.currentEntry()?.directory) {
      cx.stop_propagation();
      if (!this.tree.expanded.has(this.selected)) this.toggle(this.selected, cx);
      else if (entries[index + 1]?.depth > entries[index]?.depth) { this.selected = entries[index + 1].path; cx.notify(); }
    } else if (e.key === "left" && this.selected) {
      cx.stop_propagation();
      if (this.tree.expanded.has(this.selected)) this.toggle(this.selected, cx);
      else { this.selected = parentPath(this.selected); cx.notify(); }
    } else if (e.key === "backspace" && this.path) {
      cx.stop_propagation(); this.navigate(parentPath(this.path), cx);
    } else if (e.keystroke === "r") { cx.stop_propagation(); this.refresh(cx); }
    else if (e.key === "c" && (e.modifiers.control || e.modifiers.platform)) { cx.stop_propagation(); this.copyPath(cx); }
    else if (e.key === "f2") { cx.stop_propagation(); this.begin("mv", cx); }
  }
  resizePanel(size) { this.panelSize = { width: unzoom(size.width), height: unzoom(size.height) }; }
  resizeViewport(size, cx) {
    const height = unzoom(size.height);
    if (height !== this.viewportHeight) { this.viewportHeight = height; cx.notify(); }
  }
  maxScroll(rows = this.tree.rows(this.showHidden)) { return Math.max(0, rows.length * ROW + 2 * PAD - this.viewportHeight); }
  scrollBy(delta, cx) {
    const next = Math.max(0, Math.min(this.scrollOffset - delta, this.maxScroll()));
    if (next !== this.scrollOffset) { this.scrollOffset = next; this.dropTarget = null; cx.notify(); }
  }
  scrollToItem(index) {
    if (index < 0) return;
    // The list's padding belongs to the first and last rows.
    const top = index * ROW, bottom = (index + 1) * ROW + 2 * PAD;
    if (top < this.scrollOffset) this.scrollOffset = top;
    else if (bottom > this.scrollOffset + this.viewportHeight) this.scrollOffset = Math.min(bottom - this.viewportHeight, this.maxScroll());
  }
  renderTree(t, wide, enabled) {
    const rows = this.tree.rows(this.showHidden), height = this.viewportHeight, maximum = this.maxScroll(rows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maximum));
    const first = Math.floor(Math.max(0, this.scrollOffset - PAD) / ROW), end = Math.min(rows.length, first + Math.ceil(height / ROW) + 1);
    const content = rows.length * ROW + 2 * PAD, thumbHeight = Math.min(height, Math.max(24, height * height / Math.max(height, content)));
    const travel = height - thumbHeight, thumbTop = maximum ? this.scrollOffset / maximum * travel : 0;
    // Build only visible rows in the ordinary render, where GPUI permits
    // pointer handlers. Deferred native list rows cannot register handlers.
    return div().id("files-list-focus").relative().flex_1().min_h(40).min_w(0).overflow_hidden()
      .role("tree").accessibility_label(this.l.files).track_focus(this.listFocus).tab_stop(true)
      .on_size_change((size, cx) => this.resizeViewport(size, cx))
      .on_key_down((e, cx) => { if (!this.operation && enabled) this.listKey(e, cx); })
      .on_scroll_wheel((e, cx) => { cx.stop_propagation(); this.scrollBy(unzoom(e.delta.y), cx); })
      .on_mouse_move((e, cx) => {
        if (!this.scrollPress || !travel) return;
        this.scrollOffset = Math.max(0, Math.min(this.scrollPress.offset + unzoom(e.position.y - this.scrollPress.y) * maximum / travel, maximum));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { if (this.scrollPress) { this.scrollPress = null; cx.stop_propagation(); } })
      .on_hover((hovered) => { if (!hovered) this.scrollPress = null; })
      .child(v_flex().absolute().left(PAD).right(maximum ? 12 : PAD).top(PAD + first * ROW - this.scrollOffset)
        .children(rows.slice(first, end).map(item => treeRow(this, item, t, wide))))
      .when(maximum > 0, el => el.child(div().id("tree-scroll-track").absolute().right(0).top(0).w(10).h(height)
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation(); this.press = this.dropTarget = null;
          this.scrollOffset = Math.max(0, Math.min((unzoom(e.local_position?.y ?? 0) - thumbHeight / 2) / travel * maximum, maximum));
          cx.notify();
        })
        .child(div().id("tree-scroll-thumb").absolute().right(3).top(thumbTop).w(4).h(thumbHeight).rounded(2).bg(t.input)
          .hover(el => el.bg(t.muted))
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.press = this.dropTarget = null; this.scrollPress = { y: e.position.y, offset: this.scrollOffset }; })
          .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.scrollPress = null; }))))
      .when(!rows.length && this.available(), el => el.child(div().px(12).py(10).text_size(11).text_color(t.dim)
        .child(this.loading ? this.l.filesLoading : this.entries.length ? this.l.filesHiddenOnly : this.error ? "" : this.l.filesEmpty)));
  }
  location(t) {
    const local = this.machine == null;
    return h_flex().id("files-machine").h(28).max_w(110).flex_none().px(8).gap(5).items_center().rounded(5)
      .border(0.5).border_color(faded(t.border, 0.6)).bg(faded(t.selected, 0.2))
      .tooltip(`${this.name} · ${this.l.filesIndependent}`).accessibility_label(this.name)
      .child(svg(`mods/system-status/${local ? "computer" : "server"}.svg`).size(12).flex_none().text_color(t.muted))
      .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(this.name));
  }
  render(t, width) {
    const l = this.l, ready = this.available(), enabled = ready && !this.loading && !this.working;
    const entry = this.currentEntry(), movable = enabled && Boolean(entry) && !entry.root && entry.kind !== "o";
    // At the minimum panel width the toolbar still fits on one line.
    const tool = (icon, pressed = false) => ({ icon, pressed, compact: width < 260 });
    const body = v_flex().id("files-panel").relative().role("tab_panel").accessibility_label(l.files)
      .flex_1().min_h(0).min_w(0).p(12).gap(8).overflow_hidden()
      .on_size_change((size) => this.resizePanel(size))
      .on_mouse_move((e) => { this.panelBounds = e.bounds; })
      .on_mouse_up("left", (_e, cx) => { if (this.press) this.drop(null, cx); })
      .on_hover((hovered, cx) => { if (!hovered && this.press) { this.press = this.dropTarget = null; cx.notify(); } });
    body.child(h_flex().gap(6).min_w(0).items_center()
      .child(this.location(t))
      .child(this.input(this.pathInput, "files-path-input", t))
      .child(this.button("go", l.go, enabled, cx => this.navigate(this.pathInput.value(), cx), t)));
    if (!ready) body.child(banner(this.connectionStatus(), t.muted, "status", t));
    body.child(h_flex().gap(width < 260 ? 0 : 2).min_w(0).items_center().flex_wrap()
      .child(this.button("up", l.up, enabled && Boolean(this.path) && this.path !== "/", cx => this.navigate(parentPath(this.path), cx), t, tool("arrow-up")))
      .child(this.button("home", l.home, enabled, cx => this.navigate("~", cx), t, tool("home")))
      .child(this.button("root", l.rootDirectory, enabled, cx => this.navigate("/", cx), t, tool("root")))
      .child(this.button("hidden", this.showHidden ? l.hideHidden : l.showHidden, enabled, cx => {
        if (!this.available() || this.working) return;
        this.showHidden = !this.showHidden;
        if (!this.visibleEntries().some(row => row.path === this.selected)) this.selected = null;
        this.remember(); this.pumpBranches(cx);
        cx.notify();
      }, t, tool(this.showHidden ? "eye" : "eye-off", this.showHidden)))
      .child(div().w(1).h(16).mx(width < 260 ? 3 : 5).flex_none().bg(t.border))
      .child(this.button("path", l.copyPath, enabled && Boolean(this.path), cx => this.copyPath(cx), t, tool("clipboard")))
      .child(this.button("open", l.openFolder, enabled && Boolean(entry?.directory), cx => this.navigate(this.selected, cx), t, tool("folder-open")))
      .child(this.button("copy", l.copyFile, movable, cx => this.begin("cp", cx), t, tool("copy")))
      .child(this.button("move", l.moveFile, movable, cx => this.begin("mv", cx), t, tool("pencil"))));
    if (this.operation) {
      const label = this.operation.action === "cp" ? l.confirmCopy : l.confirmMove;
      body.child(v_flex().gap(7).p(10).rounded(6).flex_none().min_w(0)
        .border(0.5).border_color(faded(t.border, 0.6)).bg(faded(t.selected, 0.2))
        .child(div().text_size(12).font_medium().child(label))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).tooltip(displayPath(this.operation.source))
          .child(`${l.sourcePath}: ${displayPath(this.operation.source)}`))
        .child(this.input(this.destinationInput, "files-destination-input", t))
        .child(div().text_size(10.5).text_color(t.dim).child(l.destinationHint))
        .child(h_flex().gap(6).justify_end()
          .child(this.button("cancel", l.cancel, !this.working, cx => this.cancel(cx), t))
          .child(this.button("confirm", this.working ? l.fileWorking : label, enabled, cx => this.confirm(cx), t, { primary: true }))));
    }
    if (this.error) body.child(banner(this.error, t.blocked, "alert", t));
    if (this.notice) body.child(banner(this.notice, t.accent, "status", t).truncate().tooltip(this.notice));
    if (this.limited) body.child(banner(l.filesLimited, t.muted, "status", t));
    body.child(v_flex().flex_1().min_h(0).min_w(0).rounded(6).overflow_hidden()
      .border(0.5).border_color(faded(t.border, 0.6)).bg(faded(t.selected, 0.12))
      .when(Boolean(this.path), el => el.child(treeHeader(this, t)))
      .child(this.renderTree(t, width >= 460, enabled)));
    if (this.menu) body.child(contextMenu(this, t));
    return body;
  }
  dragging() { return Boolean(this.press?.dragging); }
  status() {
    if (this.dragging() && this.available()) return this.dropTarget ? `${this.l.dropToMove} ${displayPath(this.dropTarget)}` : this.l.dragHint;
    return !this.available() ? this.connectionStatus() : this.working ? this.l.fileWorking : this.loading ? this.l.filesLoading
      : `${this.visibleEntries().length} ${this.l.fileCount} · ${this.l.filesManual}`;
  }
  connectionStatus() {
    return this.connection === "loading" ? this.l.connecting : this.connection === "unsupported" ? this.l.unsupported : this.l.unavailable;
  }
  close() {
    this.closed = true; this.generation++;
    this.pathInput.release(); this.destinationInput.release(); this.listFocus.release();
    this.menuFocus.release(); this.menu = this.press = null;
    for (const handle of Object.values(this.handles)) handle.release();
  }
}
