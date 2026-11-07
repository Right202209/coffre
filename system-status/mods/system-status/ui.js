import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { metricColors, networkScale } from "./charts.js";
import { valid, clamp, percentage, formatBytes, formatUptime } from "./metrics.js";

export function faded(color, opacity) {
  if (!/^#[\da-f]{6}([\da-f]{2})?$/i.test(color)) return color;
  const alpha = color.length === 9 ? parseInt(color.slice(7), 16) : 255;
  return color.slice(0, 7) + Math.round(opacity * alpha).toString(16).padStart(2, "0");
}
const text = (value, color, size = 11) => div().min_w(0).truncate().text_size(size).text_color(color).child(value);
const mono = (value, color, size = 11) => text(value, color, size).font_family("Geist Mono").text_right();

export function resourceBar(id, value, t, reducedMotion) {
  const fill = div().id(`${id}-fill`).h_full().w(`${valid(value) ? clamp(value) : 0}%`).rounded(2)
    .bg(value > 85 ? t.blocked : value > 60 ? "#fbbf24" : t.accent);
  if (!reducedMotion) fill.transition("width", 500);
  return div().h(4).w_full().rounded(2).bg(t.selected).overflow_hidden().child(fill);
}
function metricCard(key, label, value, detail, pct, center, t, assets, l) {
  const color = metricColors[key];
  const ring = div().relative().size(64).flex_none()
    .child(svg("mods/system-status/ring.svg").size_full().text_color(faded(t.muted, 0.18)))
    .when(valid(pct) && Boolean(assets?.ring), e => e.child(svg(assets.ring).absolute().inset_0().size_full().text_color(color)))
    .child(h_flex().absolute().inset_0().items_center().justify_center().child(mono(center, t.foreground, 10)));
  return v_flex().flex_1().min_w(0).overflow_hidden().p(12).gap(5).rounded(6)
    .border(0.5).border_color(faded(t.border, 0.6)).bg(faded(t.selected, 0.2))
    .child(h_flex().gap(5).items_center().min_w(0)
      .child(svg(`mods/system-status/${key}.svg`).size(12).flex_none().text_color(color))
      .child(text(label, t.muted)))
    .child(mono(value, t.foreground, 17).text_left().tooltip(value))
    .child(text(detail, t.muted, 10).tooltip(detail))
    .child(h_flex().justify_center().child(ring))
    .child(div().w_full().h(36).overflow_hidden()
      .when(Boolean(assets?.trend), e => e.child(svg(assets.trend).w_full().h(34).text_color(color))))
    .when(key === "network", e => e.tooltip(l.scale));
}
function pill(label, value, t, tooltip) {
  return v_flex().flex_1().min_w(0).gap(3).p(8).rounded(4).bg(faded(t.selected, 0.12))
    .child(text(label, t.muted, 10)).child(mono(value, t.foreground).text_left().tooltip(tooltip ?? value));
}
function section(title, hint, children, t) {
  return v_flex().p(12).gap(9).rounded(6).min_w(0).overflow_hidden()
    .border(0.5).border_color(faded(t.border, 0.6)).bg(faded(t.selected, 0.12))
    .child(h_flex().justify_between().gap(8).min_w(0).child(text(title, t.foreground, 11).font_medium())
      .child(mono(hint, t.muted, 10)))
    .children(children.length ? children : [text("--", t.muted)]);
}
function resourceRow(id, label, value, pct, t, reducedMotion, tooltip) {
  return v_flex().min_w(0).gap(5)
    .child(h_flex().min_w(0).gap(8).items_center()
      .child(text(label, t.muted).flex_1().tooltip(tooltip ?? label))
      .child(mono(value, t.foreground).flex_none()))
    .child(resourceBar(id, pct, t, reducedMotion));
}

export function overview(sample, _history, t, assets, l, reducedMotion, width = 344) {
  const s = sample, cpu = s.cpu, mem = s.memory, disk = s.disk, net = s.network;
  const rate = net?.rx == null ? null : net.rx + net.tx;
  const memoryDetail = mem?.used != null ? `${formatBytes(mem.used)} / ${formatBytes(mem.total)}` : `${l.total} ${formatBytes(mem?.total)}`;
  const diskDetail = disk ? `${formatBytes(disk.used)} / ${formatBytes(disk.total)}${s.diskStale ? ` · ${l.cached}` : ""}` : l.unavailableMetric;
  const body = v_flex().gap(8).min_w(0)
    .child((width < 260 ? v_flex() : h_flex()).gap(8).min_w(0)
      .child(metricCard("cpu", l.cpu, percentage(cpu.percent), valid(cpu.count) ? `${cpu.count} ${l.cores}` : l.unavailableMetric,
        cpu.percent, percentage(cpu.percent), t, assets?.cpu, l))
      .child(metricCard("memory", l.memory, percentage(mem?.percent), memoryDetail, mem?.percent,
        percentage(mem?.percent), t, assets?.memory, l)))
    .child((width < 260 ? v_flex() : h_flex()).gap(8).min_w(0)
      .child(metricCard("disk", l.disk, percentage(disk?.percent), diskDetail, disk?.percent,
        percentage(disk?.percent), t, assets?.disk, l))
      .child(metricCard("network", l.network, rate == null ? "--" : `${formatBytes(rate)}/s`,
        net?.rx == null ? l.baseline : `↓ ${formatBytes(net.rx)}/s · ↑ ${formatBytes(net.tx)}/s`,
        networkScale(rate), rate == null ? "--" : "⇅", t, assets?.network, l)))
    .when(s.platform === "Darwin", e => e.child(text(l.macMemory, t.muted, 10).tooltip(l.macMemory)))
    .when(s.diskStale, e => e.child(text(l.diskError, t.muted, 10).tooltip(l.diskError)))
    .child(h_flex().gap(8).min_w(0)
      .child(pill(l.load, valid(s.load) ? s.load.toFixed(2) : "--", t))
      .child(pill(l.uptime, formatUptime(s.uptime), t)))
    .child(h_flex().gap(8).min_w(0).child(pill(l.os, s.os ?? "--", t)).child(pill(l.kernel, s.kernel ?? "--", t)))
    .child(h_flex().gap(8).min_w(0)
      .child(pill(l.swap, mem?.swapUsed == null ? "--" : `${formatBytes(mem.swapUsed)} / ${formatBytes(mem.swapTotal)}`, t))
      .child(pill(l.response, valid(s.responseMs) ? `${Math.round(s.responseMs)} ms` : "--", t, l.responseNote)))
    .child(section(l.cores, valid(s.load) && cpu.count > 0 ? `${l.perCore} ${(s.load / cpu.count).toFixed(2)}` : "", cpu.cores.slice(0, 12).map(c =>
      resourceRow(`core-${c.name}`, c.name, percentage(c.percent), c.percent, t, reducedMotion)), t))
    .child(section(l.disk, disk?.scope === "root" ? l.root : l.localDisks, (disk?.disks ?? []).slice(0, 12).map((d, i) =>
      resourceRow(`disk-${i}`, d.mount, percentage(d.percent), d.percent, t, reducedMotion,
        `${d.device} · ${d.fs} · ${formatBytes(d.used)} / ${formatBytes(d.total)}`)), t))
    .child(section(l.interfaces, "↓ / ↑", (net?.interfaces ?? []).slice(0, 5).map(i =>
      h_flex().min_w(0).gap(6).items_center().child(text(i.name, t.muted).flex_1().tooltip(i.name))
        .child(mono(i.rx == null ? "--" : `${formatBytes(i.rx)}/s`, t.foreground).flex_none())
        .child(mono(i.tx == null ? "--" : `${formatBytes(i.tx)}/s`, t.foreground).flex_none())), t))
    .child(section(l.processes, "RSS", s.processes.slice(0, 5).map(p =>
      resourceRow(`process-${p.pid}`, `${p.name} · ${p.pid}`, formatBytes(p.rss), p.percent, t, reducedMotion,
        `${p.name} · PID ${p.pid} · ${percentage(p.percent)}`)), t));
  return body;
}
