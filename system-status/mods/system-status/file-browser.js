import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { hc, shared, setShared } from "herdr";
import { listFiles, operateFile, parentPath, browsePath } from "./files.js";
import { formatBytes } from "./metrics.js";
import { translations } from "./i18n.js";

const BROWSER_STATE = "system-status.files.browser";
// Keep control characters visible without changing the path used by commands.
const displayPath = path => path.replace(/[\x00-\x1f\x7f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

export class FileBrowser {
  constructor(cx, language) {
    this.l = translations(language);
    const saved = shared(BROWSER_STATE);
    this.startPath = typeof saved?.path === "string" && saved.path.startsWith("/") && !saved.path.includes("\0") ? saved.path : "~";
    this.pathInput = InputState.new({ placeholder: this.l.filePath, value: this.startPath });
    this.destinationInput = InputState.new({ placeholder: this.l.destination });
    this.listFocus = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new();
    this.handles = Object.fromEntries(["up", "home", "root", "go", "hidden", "path", "open", "copy", "move", "confirm", "cancel"]
      .map(key => [key, cx.focus_handle()]));
    this.generation = 0; this.closed = false; this.loading = false; this.working = false;
    this.path = ""; this.entries = []; this.selected = null; this.operation = null;
    this.showHidden = saved?.showHidden === true; this.error = ""; this.notice = ""; this.limited = false; this.loaded = false;
    this.pathInput.on("submit", (_e, cx) => this.navigate(this.pathInput.value(), cx));
    this.destinationInput.on("submit", (_e, cx) => this.confirm(cx));
  }
  sync(active, cx) {
    // This browser belongs to the local system, never to a terminal or space.
    if (active && !this.loaded && !this.loading) this.load(this.startPath, cx);
  }
  available() { return !this.closed; }
  remember() {
    setShared(BROWSER_STATE, { path: this.path || this.startPath, showHidden: this.showHidden });
  }
  currentEntry() { return this.entries.find(entry => entry.path === this.selected); }
  visibleEntries() { return this.entries.filter(entry => this.showHidden || !entry.name.startsWith(".")); }
  failure(error) { return this.l.fileErrors[error?.code] ?? this.l.fileFailed; }
  load(path, cx, keepNotice = false) {
    if (!this.available() || this.working || this.loading) return;
    const generation = ++this.generation;
    this.loading = true; this.error = ""; this.operation = null;
    if (!keepNotice) this.notice = "";
    cx.spawn(async cx => {
      try {
        const result = await listFiles(hc, null, path);
        if (!this.valid(generation)) return;
        const changed = this.path !== result.path;
        this.path = result.path; this.entries = result.entries; this.limited = result.limited;
        this.pathInput.set_value(result.path);
        if (changed || !this.currentEntry()) this.selected = null;
        if (changed) this.scroll.scroll_to_item(0);
        this.remember();
      } catch (error) {
        if (this.valid(generation)) {
          this.error = this.failure(error);
          if (this.path) this.pathInput.set_value(this.path);
        }
      } finally {
        if (this.valid(generation)) { this.loaded = true; this.loading = false; cx.notify(); }
      }
    });
  }
  valid(generation) { return !this.closed && this.generation === generation; }
  navigate(value, cx) {
    if (this.working || this.loading) return;
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
    if (!entry || entry.kind === "o" || !this.available() || this.loading || this.working) return;
    this.operation = { action, source: entry.path, base: this.path };
    this.destinationInput.set_value(entry.path);
    this.destinationInput.focus(); this.notice = ""; this.error = ""; cx.notify();
  }
  cancel(cx) {
    if (!this.operation || this.working) return false;
    this.operation = null; this.error = ""; this.listFocus.focus(); cx.notify(); return true;
  }
  confirm(cx) {
    const operation = this.operation;
    if (!operation || this.working || !this.available()) return;
    const destination = this.destinationInput.value();
    if (!destination || destination.includes("\0")) { this.error = this.l.fileErrors["invalid-path"]; cx.notify(); return; }
    const generation = this.generation;
    this.working = true; this.error = ""; this.notice = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await operateFile(hc, null, operation.action, operation.source, destination, operation.base);
        if (!this.valid(generation)) return;
        this.working = false; this.operation = null; this.selected = null;
        this.notice = `${operation.action === "cp" ? this.l.fileCopied : this.l.fileMoved} ${displayPath(result)}`;
        this.listFocus.focus(); this.load(operation.base, cx, true);
      } catch (error) {
        if (this.valid(generation)) { this.working = false; this.error = this.failure(error); }
      } finally { if (!this.closed) cx.notify(); }
    });
  }
  button(key, label, enabled, action, t) {
    const handle = this.handles[key];
    const activate = (_event, cx) => { cx.stop_propagation(); if (enabled) action(cx); };
    return div().id(`files-${key}`).role("button").accessibility_label(label).tooltip(label)
      .track_focus(handle).tab_stop(enabled).disabled(!enabled).h(25).px(7).flex_none().rounded(4)
      .flex().items_center().justify_center().text_color(enabled ? t.foreground : t.muted)
      .bg(handle.is_focused() ? t.selected : t.chrome)
      .when(enabled, e => e.hover(el => el.bg(t.hover)).on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); handle.focus(); }))
      .on_click(activate).on_key_down((e, cx) => { if (["enter", "space"].includes(e.key)) activate(e, cx); })
      .child(label);
  }
  input(state, id, t) {
    // Let the native input receive text events. Panel shortcuts check their
    // own focus handles, so typing here cannot trigger the refresh shortcut.
    return div().min_w(0).flex_1()
      .child(Input.new(state).id(id).h(28).w_full().min_w(0).px(7).rounded(4)
        .border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(11)
        .accessibility_label(id === "files-path-input" ? this.l.filePath : this.l.destination));
  }
  listKey(e, cx) {
    const entries = this.visibleEntries(), index = entries.findIndex(entry => entry.path === this.selected);
    if (["up", "down", "home", "end"].includes(e.key) && entries.length) {
      const next = e.key === "home" ? 0 : e.key === "end" ? entries.length - 1
        : Math.max(0, Math.min(entries.length - 1, index + (e.key === "up" ? -1 : 1)));
      cx.stop_propagation(); this.selected = entries[next].path; this.scroll.scroll_to_item(next, "center"); cx.notify();
    } else if (e.key === "enter" && this.currentEntry()?.directory) {
      cx.stop_propagation(); this.navigate(this.selected, cx);
    } else if (e.key === "backspace" && this.path) {
      cx.stop_propagation(); this.navigate(parentPath(this.path), cx);
    } else if (e.keystroke === "r") { cx.stop_propagation(); this.refresh(cx); }
    else if (e.key === "c" && (e.modifiers.control || e.modifiers.platform)) { cx.stop_propagation(); this.copyPath(cx); }
    else if (e.key === "f2") { cx.stop_propagation(); this.begin("mv", cx); }
  }
  render(t, width) {
    const l = this.l, ready = this.available(), enabled = ready && !this.loading && !this.working;
    const entry = this.currentEntry(), entries = this.visibleEntries();
    const body = v_flex().id("files-panel").role("tab_panel").accessibility_label(l.files)
      .flex_1().min_h(0).min_w(0).p(12).gap(8).overflow_hidden();
    body.child(div().min_w(0).truncate().text_color(t.muted).tooltip(l.filesIndependent).child(l.local));
    body.child(h_flex().gap(5).min_w(0)
      .child(this.input(this.pathInput, "files-path-input", t))
      .child(this.button("go", l.go, enabled, cx => this.navigate(this.pathInput.value(), cx), t)));
    body.child(h_flex().gap(3).min_w(0).flex_wrap()
      .child(this.button("up", l.up, enabled && Boolean(this.path) && this.path !== "/", cx => this.navigate(parentPath(this.path), cx), t))
      .child(this.button("home", l.home, enabled, cx => this.navigate("~", cx), t))
      .child(this.button("root", l.rootDirectory, enabled, cx => this.navigate("/", cx), t))
      .child(this.button("hidden", this.showHidden ? l.hideHidden : l.showHidden, !this.working, cx => {
        this.showHidden = !this.showHidden;
        if (!this.showHidden && this.currentEntry()?.name.startsWith(".")) this.selected = null;
        this.remember();
        cx.notify();
      }, t)));
    body.child(h_flex().gap(3).min_w(0).flex_wrap()
      .child(this.button("path", l.copyPath, enabled && Boolean(this.path), cx => this.copyPath(cx), t))
      .child(this.button("open", l.openFolder, enabled && Boolean(entry?.directory), cx => this.navigate(this.selected, cx), t))
      .child(this.button("copy", l.copyFile, enabled && Boolean(entry) && entry.kind !== "o", cx => this.begin("cp", cx), t))
      .child(this.button("move", l.moveFile, enabled && Boolean(entry) && entry.kind !== "o", cx => this.begin("mv", cx), t)));
    if (this.operation) {
      body.child(v_flex().gap(6).p(9).rounded(4).border(1).border_color(t.border).flex_none()
        .child(div().child(this.operation.action === "cp" ? l.confirmCopy : l.confirmMove))
        .child(div().min_w(0).truncate().text_color(t.muted).tooltip(displayPath(this.operation.source))
          .child(`${l.sourcePath}: ${displayPath(this.operation.source)}`))
        .child(this.input(this.destinationInput, "files-destination-input", t))
        .child(div().text_size(10).text_color(t.muted).child(l.destinationHint))
        .child(h_flex().gap(5)
          .child(this.button("confirm", this.working ? l.fileWorking : this.operation.action === "cp" ? l.confirmCopy : l.confirmMove,
            !this.working, cx => this.confirm(cx), t))
          .child(this.button("cancel", l.cancel, !this.working, cx => this.cancel(cx), t))));
    }
    if (this.error) body.child(div().role("alert").text_color(t.blocked).child(this.error));
    if (this.notice) body.child(div().role("status").min_w(0).truncate().tooltip(this.notice).text_color(t.accent).child(this.notice));
    if (this.loading) body.child(div().role("status").text_color(t.muted).child(l.filesLoading));
    if (this.limited) body.child(div().text_color(t.muted).child(l.filesLimited));
    const wide = width >= 500;
    body.child(h_flex().h(22).flex_none().px(6).gap(8).text_color(t.muted)
      .child(div().flex_1().min_w(0).child(l.fileName))
      .child(div().w(65).text_right().child(l.fileSize))
      .when(wide, el => el.child(div().w(120).text_right().child(l.fileModified))));
    const list = v_virtual_list("system-files-list", entries.length, 29, index => entries[index].path,
      range => entries.slice(range.start, range.end).map(item => {
        const kind = item.kind === "l" ? l.symlink : item.directory ? l.folder : item.kind === "f" ? l.file : l.specialFile;
        const modified = item.modified == null ? "—" : new Date(item.modified).toISOString().slice(0, 16).replace("T", " ");
        return h_flex().h(29).px(6).gap(8).items_center().min_w(0).rounded(3)
          .role("list_box_option").aria_selected(this.selected === item.path).accessibility_label(`${displayPath(item.name)}, ${kind}`)
          .bg(this.selected === item.path ? t.selected : t.chrome).hover(el => el.bg(t.hover))
          .child(svg(`mods/system-status/${item.directory ? "folder" : "file"}.svg`).size(13).flex_none().text_color(item.directory ? t.accent : t.muted))
          .child(div().flex_1().min_w(0).truncate().tooltip(`${displayPath(item.path)} · ${kind}`).child(displayPath(item.name)))
          .when(item.kind === "l", el => el.child(div().text_color(t.muted).child("↗")))
          .child(div().w(65).flex_none().text_right().text_color(t.muted).child(item.directory ? "—" : formatBytes(item.size)))
          .when(wide, el => el.child(div().w(120).flex_none().text_right().text_color(t.muted).tooltip(`${modified} UTC`).child(modified)));
      })).track_scroll(this.scroll).size_full().min_h(0)
      .on_item_click((key, cx) => {
        if (!enabled || this.operation) return;
        const double = this.selected === key && Date.now() - (this.lastClickAt ?? 0) < 400;
        this.selected = key; this.lastClickAt = Date.now(); this.listFocus.focus();
        if (double && this.currentEntry()?.directory) this.navigate(key, cx); else cx.notify();
      });
    body.child(v_flex().id("files-list-focus").relative().flex_1().min_h(40).min_w(0).role("list_box").accessibility_label(l.files)
      .track_focus(this.listFocus).tab_stop(true).on_key_down((e, cx) => { if (!this.operation && enabled) this.listKey(e, cx); })
      .child(list).child(Scrollbar.vertical("system-files-list").absolute().inset_0())
      .when(!entries.length && !this.loading, el => el.child(div().absolute().inset_0().p(8).text_color(t.muted)
        .child(this.entries.length ? l.filesHiddenOnly : this.error ? "" : l.filesEmpty))));
    if (!this.operation) body.child(div().text_size(10).text_color(t.muted).child(l.filesHint));
    return body;
  }
  status() {
    return this.working ? this.l.fileWorking : this.loading ? this.l.filesLoading
      : `${this.visibleEntries().length} ${this.l.fileCount} · ${this.l.filesManual}`;
  }
  close() {
    this.closed = true; this.generation++;
    this.pathInput.release(); this.destinationInput.release(); this.listFocus.release(); this.scroll.release();
    for (const handle of Object.values(this.handles)) handle.release();
  }
}
