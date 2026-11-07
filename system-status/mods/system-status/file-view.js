import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { settings, window } from "herdr";
import { formatBytes } from "./metrics.js";
import { faded } from "./ui.js";

// Tree geometry in layout pixels; rendering and keyboard scrolling share it.
export const ROW = 28, PAD = 4, INDENT = 16;
const clear = "#00000000";
// Pointer and size events arrive in window pixels, which grow with Herdr's zoom.
export const unzoom = value => Math.round(value / (Number(settings()?.zoom) || 1) * 100) / 100;
// Keep control characters visible without changing the path used by commands.
export const displayPath = path => path.replace(/[\x00-\x1f\x7f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
export const baseName = path => path.replace(/\/+$/, "").split("/").pop() || "/";
export const shortcut = (modifier, key) => key === undefined ? modifier
  : window()?.platform === "macos" ? `⌘${key}` : `Ctrl+${key}`;
export function rowMeta(entry) {
  if (entry.directory) return { size: "", modified: "" };
  return { size: formatBytes(entry.size),
    modified: entry.modified == null ? "" : new Date(entry.modified).toISOString().slice(0, 16).replace("T", " ") };
}
const icon = (name, size, color) => svg(`mods/system-status/${name}.svg`).size(size).flex_none().text_color(color);
const meta = (value, width, t) => div().w(width).flex_none().text_right().truncate().text_size(10.5)
  .font_family("Geist Mono").text_color(t.muted).child(value);

export function banner(text, color, role, t) {
  return div().role(role).flex_none().min_w(0).px(9).py(6).rounded(5).text_size(11)
    .bg(faded(color, 0.1)).border(0.5).border_color(faded(color, 0.3)).text_color(color).child(text);
}

// Row, tree header and drop target share one pointer contract.
function pointerTarget(el, browser, path, directory) {
  const blocked = () => !browser.available() || Date.now() < browser.suppressClickUntil
    || browser.loading || browser.working || browser.operation;
  return el
    .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); browser.startPress(path, e, cx); })
    .on_mouse_down("right", (e, cx) => browser.openMenu(path, e, cx))
    .on_mouse_move((e, cx) => browser.dragOver(path, e, cx))
    .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); browser.drop(path, cx); })
    .on_click((e, cx) => {
      if (blocked()) return;
      browser.selected = path; browser.listFocus.focus();
      if (e.click_count === 2 && directory) browser.toggle(path, cx);
      cx.notify();
    });
}

export function treeHeader(browser, t) {
  const path = browser.path, l = browser.l, target = browser.dropTarget === path;
  return pointerTarget(h_flex().id(`tree-row-${path}`).h(32).flex_none().pl(10).pr(10).gap(7).items_center().min_w(0)
    .border_b(0.5).border_color(target ? t.accent : faded(t.border, 0.6))
    .bg(target ? faded(t.accent, 0.22) : browser.selected === path ? t.selected : clear)
    .role("tree_item").aria_selected(browser.selected === path)
    .accessibility_label(`${displayPath(path)}, ${l.folder}`), browser, path, false)
    .child(icon("folder-open", 14, t.accent))
    .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(t.foreground)
      .tooltip(displayPath(path)).child(displayPath(baseName(path))))
    .when(browser.loading, el => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(l.filesLoading)));
}

export function treeRow(browser, item, t, wide) {
  const l = browser.l, indent = 4 + Math.min(item.depth, 12) * INDENT;
  if (item.message) {
    const label = item.message === "loading" ? l.filesLoading : item.message === "empty" ? l.filesEmpty
      : item.message === "limited" ? l.filesLimited : l.fileErrors[item.message] || l.fileFailed;
    return h_flex().id(`tree-message-${item.path}`).h(ROW).flex_none().pl(indent + 20).pr(8).items_center().min_w(0)
      .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).tooltip(label).child(label));
  }
  const selected = browser.selected === item.path, target = browser.dropTarget === item.path;
  const kind = item.kind === "l" ? l.symlink : item.directory ? l.folder : item.kind === "f" ? l.file : l.specialFile;
  const info = rowMeta(item), background = target ? faded(t.accent, 0.22) : selected ? t.selected : clear;
  const detail = [displayPath(item.path), kind, info.size && `${l.fileSize} ${info.size}`,
    info.modified && `${l.fileModified} ${info.modified} UTC`].filter(Boolean).join(" · ");
  return pointerTarget(h_flex().id(`tree-row-${item.path}`).h(ROW).flex_none().pl(indent).pr(8).gap(4).items_center().min_w(0)
    .rounded(5).border(1).border_color(target ? t.accent : selected && browser.listFocus.is_focused() ? t.input : clear)
    .bg(background).hover(el => el.bg(target || selected ? background : t.hover))
    .role("tree_item").aria_selected(selected)
    .accessibility_label(`${displayPath(item.name)}, ${kind}${item.directory ? `, ${item.expanded ? l.collapseFolder : l.expandFolder}` : ""}`),
  browser, item.path, item.directory)
    .child(div().id(`tree-toggle-${item.path}`).size(16).flex_none().rounded(3).flex().items_center().justify_center()
      .when(item.directory, el => el.hover(s => s.bg(t.hover)).child(icon(item.expanded ? "chevron-down" : "chevron-right", 12, t.dim)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); browser.drop(item.path, cx); })
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!browser.available() || Date.now() < browser.suppressClickUntil || browser.loading || browser.working || browser.operation) return;
        browser.selected = item.path; browser.listFocus.focus(); browser.toggle(item.path, cx);
      }))
    .child(icon(item.directory ? "folder" : "file", 14, t.muted))
    .child(h_flex().flex_1().min_w(0).ml(3).gap(4).items_center()
      // An open menu replaces the row tooltip instead of sharing its space.
      .child(div().min_w(0).truncate().text_size(12.5).text_color(t.foreground).when(!browser.menu, el => el.tooltip(detail))
        .child(displayPath(item.name)))
      .when(item.kind === "l", el => el.child(div().flex_none().text_size(11).text_color(t.muted).child("↗"))))
    .child(meta(info.size, 56, t))
    .when(wide, el => el.child(meta(info.modified, 104, t)));
}

export function contextMenu(browser, t) {
  const menu = browser.menu, items = browser.menuItems(), size = browser.panelSize ?? { width: 344, height: 500 };
  const breaks = items.filter((item, index) => index && item.group !== items[index - 1].group).length;
  const width = Math.min(212, size.width - 16), height = items.length * 28 + breaks * 9 + 10;
  return v_flex().id("files-context-menu").absolute()
    .left(Math.max(8, Math.min(menu.x, size.width - width - 8)))
    .top(Math.max(8, Math.min(menu.y, size.height - height - 8)))
    .w(width).p(4).rounded(8).border(1).border_color(t.input).bg(t.popover).shadow_md()
    .role("menu").accessibility_label(browser.l.fileActions).track_focus(browser.menuFocus)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
    .on_mouse_down_out((_e, cx) => { if (browser.menu) { browser.menu = null; cx.notify(); } })
    .on_key_down((e, cx) => {
      cx.stop_propagation();
      if (e.key === "escape") browser.cancel(cx);
      else if (e.key === "up" || e.key === "down") { menu.index = (menu.index + (e.key === "up" ? items.length - 1 : 1)) % items.length; cx.notify(); }
      else if (e.key === "enter") browser.chooseMenu(items[menu.index].action, cx);
    })
    .children(items.flatMap((item, index) => [
      ...(index && item.group !== items[index - 1].group ? [div().h(1).mx(4).my(4).flex_none().bg(t.border)] : []),
      h_flex().id(`file-menu-${item.action}`).h(28).flex_none().px(8).gap(12).rounded(5).items_center()
        .role("menu_item").accessibility_label(item.label)
        .bg(index === menu.index ? t.hover : clear).text_color(t.foreground)
        .on_mouse_move((_e, cx) => { if (menu.index !== index) { menu.index = index; cx.notify(); } })
        .on_click((_e, cx) => { cx.stop_propagation(); browser.chooseMenu(item.action, cx); })
        .child(div().flex_1().min_w(0).truncate().child(item.label))
        .when(Boolean(item.shortcut), el => el.child(div().flex_none().text_size(10.5).text_color(t.muted).child(item.shortcut))),
    ]));
}
