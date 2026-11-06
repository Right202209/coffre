import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { hc, theme, layout, run, props, focused, spaces, machines, panes, shared, setShared, nextCommand } from "herdr";
import { collect } from "./collectors.js";
import { Coordinator } from "./coordinator.js";
import { currentTarget, panelVisible } from "./context.js";
import { Graphics } from "./graphics.js";
import { overview } from "./ui.js";
import { translations } from "./i18n.js";
import { FileBrowser } from "./file-browser.js";

export default class SystemStatus extends View {
  init(_options, cx) {
    this.options = props() ?? {};
    this.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.coordinator = new Coordinator({ get: key => shared(key), set: (key, value) => setShared(key, value) }, this.id, this.options.intervalMs);
    this.graphics = new Graphics(this.id); this.assetKey = null; this.assets = null;
    this.graphPending = false; this.paused = false; this.closed = false;
    this.activeTab = shared("system-status.tab") === "files" ? "files" : "overview";
    this.handles = Array.from({ length: 5 }, () => cx.focus_handle());
    this.files = new FileBrowser(cx, this.options.language);
    this.heartbeat = 0; this.lastContext = "";
    this.tick(cx);
    // Only lifecycle bookkeeping runs while hidden, because Herdr has no exposure event.
    this.timer = cx.timer.every(1000, cx => this.tick(cx));
    this.commandTask = cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handles[this.activeTab === "files" ? 1 : 0].focus();
        if (command === "refresh") this.refresh(cx);
        if (command === "files" || command === "overview") this.selectTab(command, cx);
        cx.notify();
      }
    });
  }
  context() {
    const options = props() ?? this.options;
    const exposed = panelVisible(layout(), options, panes(), focused());
    return { target: currentTarget(spaces(), focused(), machines(), options),
      visible: exposed && !this.paused && this.activeTab === "overview", filesVisible: exposed && this.activeTab === "files" };
  }
  tick(cx, retry = false) {
    if (this.closed) return;
    const now = Date.now(), { target, visible, filesVisible } = this.context();
    this.files.sync(filesVisible, cx);
    const context = JSON.stringify([target.machine, target.connection, visible]);
    if (target.connection === "no-session") {
      this.coordinator.release(now); this.lastContext = context; return;
    }
    if (context !== this.lastContext || now - this.heartbeat >= 5000) {
      this.coordinator.subscribe(target.machine, target.connection, visible, visible, now);
      this.lastContext = context; this.heartbeat = now;
    }
    this.coordinator.expire(now);
    const token = visible ? this.coordinator.claim(now, retry) : null;
    if (token && visible) cx.spawn(async cx => {
      try {
        const sample = await collect(hc, token.machine, token.first);
        if (this.coordinator.success(token, sample, Date.now()) && !this.closed) cx.notify();
      } catch (error) {
        this.coordinator.failure(token, String(error?.message ?? error).slice(0, 200), Date.now());
        if (!this.closed) cx.notify();
      } finally { this.coordinator.settle(token); }
    });
    const state = this.coordinator.read();
    const assetKey = JSON.stringify([target.machine, state?.sample?.at]);
    if (visible && state?.sample && assetKey !== this.assetKey && !this.graphPending) {
      const sample = state.sample, history = state.history;
      this.graphPending = true;
      cx.spawn(async cx => {
        try {
          const assets = await this.graphics.create(sample, history);
          if (!this.closed && this.context().target.machine === target.machine && this.coordinator.read()?.sample?.at === sample.at) {
            this.assets = assets; this.assetKey = assetKey; this.graphicsError = null; cx.notify();
          }
        } catch { this.graphicsError = "Vector assets unavailable"; }
        finally { this.graphPending = false; }
      });
    }
  }
  async close() {
    this.closed = true; this.timer?.cancel(); this.commandTask?.cancel();
    this.files.close();
    this.coordinator.release(Date.now());
    for (const handle of this.handles) handle.release();
    await this.graphics.close();
  }
  refresh(cx) {
    if (this.activeTab === "files") this.files.refresh(cx);
    else this.tick(cx, true);
  }
  selectTab(tab, cx) {
    this.activeTab = tab; this.handles[tab === "files" ? 1 : 0].focus();
    setShared("system-status.tab", tab);
    this.tick(cx); cx.notify();
  }
  tab(index, id, label, icon, t) {
    const active = this.activeTab === id, handle = this.handles[index];
    return h_flex().id(`${id}-tab`).role("tab").aria_selected(active).set_position(index + 1, 2).accessibility_label(label)
      .track_focus(handle).tab_stop(true).h(24).px(7).gap(5).rounded(4).items_center()
      .bg(active ? t.selected : t.chrome).text_color(active ? t.foreground : t.muted)
      .hover(e => e.bg(t.hover)).when(handle.is_focused(), e => e.border(1).border_color(t.input))
      .on_click((_e, cx) => this.selectTab(id, cx))
      .on_key_down((e, cx) => {
        if (["left", "right", "home", "end", "enter", "space"].includes(e.key)) {
          cx.stop_propagation();
          this.selectTab(e.key === "home" ? "overview" : e.key === "end" ? "files"
            : ["left", "right"].includes(e.key) ? id === "files" ? "overview" : "files" : id, cx);
        }
      })
      .child(svg(`mods/system-status/${icon}.svg`).size(12)).child(div().text_size(11).child(label));
  }
  button(index, id, label, icon, action, t) {
    return div().id(id).role("button").accessibility_label(label).tooltip(label)
      .track_focus(this.handles[index]).tab_stop(true).size(24).flex_none().rounded(4)
      .flex().items_center().justify_center().text_color(t.muted)
      .hover(e => e.bg(t.hover).text_color(t.foreground))
      .when(this.handles[index].is_focused(), e => e.bg(t.selected).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.handles[index].focus(); })
      .on_click(action).on_key_down((e, cx) => {
        if (["enter", "space"].includes(e.key)) { cx.stop_propagation(); action(e, cx); }
      }).child(icon ? svg(`mods/system-status/${icon}.svg`).size(12) : div().text_size(12).child(this.paused ? "▶" : "Ⅱ"));
  }
  render(cx) {
    const t = theme(), l = translations(this.options.language), { target, visible } = this.context();
    // Herdr re-renders on focus/layout changes. Switch subscriptions immediately,
    // including while another machine's collection is still in flight.
    if (JSON.stringify([target.machine, target.connection, visible]) !== this.lastContext) this.tick(cx);
    const state = this.coordinator.read(target.machine), s = state?.sample;
    const root = v_flex().id("system-status-root").size_full().min_w(0).overflow_hidden()
      .bg(t.chrome).text_color(t.foreground).text_size(11)
      .on_size_change((size, cx) => {
        if (this.width !== size.width) { this.width = size.width; cx.notify(); }
      })
      .on_key_down((e, cx) => {
        if (e.keystroke === "r" && this.handles.some(handle => handle.is_focused())) { cx.stop_propagation(); this.refresh(cx); }
        else if (e.key === "escape") {
          cx.stop_propagation();
          if (this.activeTab !== "files" || !this.files.cancel(cx)) run("pane.go", { direction: "left" });
        }
      })
      .child(h_flex().h(33).flex_none().px(12).gap(5).items_center().border_b(0.5).border_color(t.border)
        .child(h_flex().role("tab_list").accessibility_label(l.system).flex_1().min_w(0).gap(3)
          .child(this.tab(0, "overview", l.overview, "system", t))
          .child(this.tab(1, "files", l.files, "folder", t)))
        .child(this.button(2, "refresh", (this.activeTab === "files" ? this.files.error : state?.error) ? l.retry : l.refresh,
          "refresh", (_e, cx) => this.refresh(cx), t))
        .when(this.activeTab === "overview", e => e.child(this.button(3, "pause", this.paused ? l.resume : l.pause, null, (_e, cx) => {
          this.paused = !this.paused; this.tick(cx); cx.notify();
        }, t)))
        .when(Boolean(this.options.node), e => e.child(this.button(4, "hide", l.close, "close", () => run("layout.hide", { id: this.options.node }), t))));
    if (this.activeTab === "files") return root
      .child(this.files.render(t, this.width ?? 344))
      .child(h_flex().h(27).flex_none().px(12).items_center().min_w(0).border_t(0.5).border_color(t.border)
        .child(div().text_color(t.muted).truncate().child(this.files.status())));
    const body = v_flex().id("overview-panel").role("tab_panel").accessibility_label(l.overview)
      .flex_1().min_h(0).min_w(0).p(12).gap(8).overflow_y_scrollbar();
    const machineName = target.machine == null ? l.local : target.name;
    body.child(div().min_w(0).truncate().text_color(t.muted).tooltip(machineName).child(machineName));
    const unsupported = target.connection === "unsupported" || state?.status === "unsupported";
    if (unsupported) body.child(div().role("status").child(l.unsupported));
    else if (target.connection === "no-session") body.child(div().role("status").child(l.noSession));
    else if (target.connection !== "ready") body.child(div().role("status").child(target.connection === "loading" ? l.connecting : l.unavailable));
    if (state?.error) body.child(v_flex().gap(5).role("status")
      .child(div().child(state.error === "no-data" ? l.empty : s ? l.error : l.hardError))
      .child(div().text_color(t.muted).truncate().tooltip(state.error).child(state.error === "timeout" ? l.timeout : state.error))
      .when(state.failures >= 3, e => e.child(div().text_color(t.muted).child(l.cooldown))));
    if (s && !unsupported && target.connection !== "no-session") {
      const labels = target.machine == null ? { ...l, response: this.options.language === "en" ? "Collection response time" : "采集响应时间" } : l;
      body.child(overview(s, state.history, t, this.assetKey === JSON.stringify([target.machine, s.at]) ? this.assets : null,
        labels, this.options.reducedMotion !== false, this.width ?? 344));
    } else if (!unsupported && target.connection === "ready" && !state?.error) body.child(div().role("status").text_color(t.muted)
      .child(state?.status === "ready" ? l.empty : l.loading));
    if (this.graphicsError) body.child(div().text_color(t.muted).child(this.graphicsError));
    const status = this.paused ? l.pause : unsupported ? l.unavailableMetric
      : target.connection === "no-session" ? l.noSession
      : target.connection === "loading" ? l.connecting
      : !visible || target.connection !== "ready" || state?.error || (s && state?.first) ? s ? l.cached : l.unavailableMetric
      : s?.partial ? l.partial : s ? l.live : l.loading;
    return root.child(body).child(h_flex().h(27).flex_none().px(12).items_center().gap(6).min_w(0)
      .border_t(0.5).border_color(t.border).child(div().size(4).flex_none().rounded(2).bg(t.muted))
      .child(div().min_w(0).truncate().text_color(t.muted).tooltip(l.motion)
        .child(`${status} · ${this.coordinator.interval ? (this.options.language === "en" ? `Refresh ~${this.coordinator.interval / 1000}s` : `约每 ${this.coordinator.interval / 1000} 秒刷新`) : l.every}`)));
  }
}
