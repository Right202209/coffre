import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, openOverlay, closeOverlay, props, shared, setShared, appHome, readTextFile, keys, window } from "herdr";
import { parsePrograms } from "./launch-config.js";
import { PROFILE_FILE, DEFAULT_PROFILE, parseProfiles, launchChoices, findLaunch } from "./profiles.js";
import { ORDER, entryId, orderedEntries, moveOrder } from "./order.js";

const rowId = (agent, profile) => profile === DEFAULT_PROFILE ? `agent:${agent}` : `profile:${agent}:${profile}`;
const dropSide = e => (e.local_position?.y ?? 0) < (e.bounds?.height ?? 34) / 2 ? "before" : "after";

function shortcut(name) {
  const k = keys().find(b => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

const SELECTION = "personal-launcher.selection";

export default class AgentLauncher extends View {
  init(_props, cx) {
    const active = spaces().find(s => s.active);
    this.space = active ? { id: active.id, machine: active.machine } : null;
    this.folder = panes().find(p => p.focused)?.cwd;
    this.choices = [];
    this.drag = null;
    this.dragClick = false;
    this.focuses = new Map();
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.selectedProfiles = {};
    const saved = shared(SELECTION);
    if (saved && typeof saved === "object") {
      this.selectedAgent = typeof saved.agent === "string" ? saved.agent : null;
      if (saved.profiles && typeof saved.profiles === "object" && !Array.isArray(saved.profiles)) this.selectedProfiles = { ...saved.profiles };
    }
    for (const key of ["terminal", "manage", "retry", "space", "worktree", "worktree-open"]) this.focuses.set(key, cx.focus_handle());
    this.reload(cx);
  }

  async readChoices() {
    const [agents, raw, profiles] = await Promise.all([
      knownAgents({ on: this.space?.machine }),
      readTextFile(`${appHome()}/programs.json`),
      readTextFile(`${appHome()}/${PROFILE_FILE}`),
    ]);
    return launchChoices(agents, parsePrograms(raw), parseProfiles(profiles));
  }

  installChoices(choices, cx) {
    this.choices = choices.filter(a => a.installed);
    const selectedExists = this.choices.some(a => a.key === this.selectedAgent);
    for (const agent of this.choices) {
      if (!agent.profiles.some(p => p.id === this.selectedProfiles[agent.key])) {
        if (this.selectedProfiles[agent.key] && this.selectedProfiles[agent.key] !== DEFAULT_PROFILE) {
          this.message = "A saved profile was removed. Choose another profile.";
        }
        this.selectedProfiles[agent.key] = this.selectedProfiles[agent.key]
          ? (agent.profiles.find(p => p.id !== DEFAULT_PROFILE) ?? agent.profiles[0]).id
          : DEFAULT_PROFILE;
      }
      for (const key of agent.profiles.map(p => rowId(agent.key, p.id))) {
        if (!this.focuses.has(key)) this.focuses.set(key, cx.focus_handle());
      }
    }
    if (!selectedExists) {
      const first = this.entries()[0];
      this.selectedAgent = first?.agent.key;
      if (first) this.selectedProfiles[first.agent.key] = first.profile.id;
    }
  }

  reload(cx) {
    if (this.loading) return;
    this.loading = true;
    this.loadError = null;
    this.message = null;
    cx.spawn(async cx => {
      try { this.installChoices(await this.readChoices(), cx); }
      catch (error) { this.loadError = String(error.message ?? error); }
      this.loading = false;
      cx.notify();
    });
  }

  current() { return this.choices.find(a => a.key === this.selectedAgent); }
  profile(agent = this.current()) { return agent?.profiles.find(p => p.id === this.selectedProfiles[agent.key]); }
  order() { return shared(ORDER)?.[this.space?.machine ?? ""]; }
  entries() {
    const entry = (agent, profile) => ({ agent, profile, id: entryId(agent.key, profile.id) });
    const agents = this.choices.map(agent => entry(agent, agent.profiles.find(p => p.id === DEFAULT_PROFILE)));
    const profiles = this.choices.flatMap(agent => agent.profiles.filter(p => p.id !== DEFAULT_PROFILE).map(profile => entry(agent, profile)));
    return orderedEntries([...agents, ...profiles], this.order());
  }

  beginDrag(id, e, cx, grip = false) {
    if (this.loading || this.loadError || this.starting || !this.entries().some(entry => entry.id === id)) return;
    cx.stop_propagation();
    this.dragClick = false;
    this.drag = { id, x: e.position.x, y: e.position.y, active: false, grip, target: id, side: "before" };
  }

  dragOver(id, e, cx) {
    if (!this.drag) return;
    const active = this.drag.active || Math.abs(e.position.x - this.drag.x) + Math.abs(e.position.y - this.drag.y) > 4;
    const side = dropSide(e);
    if (active !== this.drag.active || id !== this.drag.target || side !== this.drag.side) {
      this.drag = { ...this.drag, active, target: id, side };
      cx.notify();
    }
  }

  finishDrag(id, e, cx) {
    if (!this.drag) return;
    cx.stop_propagation();
    this.dragOver(id, e, cx);
    const drag = this.drag;
    this.drag = null;
    // Click listeners and mouse-up listeners can run in either order.
    // Complete a simple row press here and suppress its subsequent click.
    this.dragClick = true;
    if (drag.active) {
      const next = moveOrder(this.entries(), this.order(), drag.id, id, dropSide(e));
      if (next) {
        const value = shared(ORDER);
        const saved = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        setShared(ORDER, { ...saved, [this.space?.machine ?? ""]: next });
      }
    } else if (!drag.grip && drag.id === id) {
      const entry = this.entries().find(entry => entry.id === id);
      if (entry) this.start(cx, entry.agent.key, entry.profile.id);
    }
    cx.notify();
  }

  cancelDrag(cx) {
    if (!this.drag) return;
    this.dragClick = this.drag.active || this.drag.grip;
    this.drag = null;
    cx.notify();
  }

  selectProfile(agentKey, id, cx) {
    if (this.starting || !this.choices.find(a => a.key === agentKey)?.profiles.some(p => p.id === id)) return;
    this.selectedAgent = agentKey;
    this.selectedProfiles[agentKey] = id;
    this.message = null;
    this.handle.focus();
    cx.notify();
  }

  manage() {
    const agent = this.current(), profile = this.profile(agent);
    closeOverlay(props().overlay);
    if (props().returnToManager) return;
    openOverlay({ mod: "agent-profiles", kind: "dialog", width: 900, height: 620,
      props: { view: "profiles", machine: this.space?.machine ?? null, ...(agent ? { agent: agent.key, profile: profile?.id } : {}) } });
  }

  start(cx, agentKey = this.selectedAgent, profileId = this.selectedProfiles[agentKey]) {
    if (this.loading || this.starting || this.loadError || this.drag) return;
    let before;
    try { before = findLaunch(this.choices, agentKey, profileId); }
    catch (error) { this.message = error.message; cx.notify(); return; }
    this.selectedAgent = agentKey;
    this.selectedProfiles[agentKey] = profileId;
    this.starting = true;
    this.message = null;
    cx.notify();
    cx.spawn(async cx => {
      let closed = false, refreshed = false;
      try {
        const choices = await this.readChoices();
        refreshed = true;
        this.installChoices(choices, cx);
        const { agent, profile } = findLaunch(choices, agentKey, profileId);
        if (JSON.stringify(before.profile.argv) !== JSON.stringify(profile.argv) || before.profile.tabName !== profile.tabName) {
          this.message = "Launch settings changed. Select this profile again to use the updated settings.";
          return;
        }
        if (this.space && !spaces().some(s => s.id === this.space.id)) throw new Error("This space was closed. Reopen the launcher.");
        run("tab.new", { name: profile.tabName, ...(this.space ? { space: this.space.id } : {}), argv: [...profile.argv] });
        const previous = shared(SELECTION);
        setShared(SELECTION, { agent: agent.key, profiles: { ...(previous?.profiles ?? {}), [agent.key]: profile.id } });
        closeOverlay(props().overlay);
        closed = true;
      } catch (error) {
        if (!refreshed) this.loadError = String(error.message ?? error);
        else this.message = String(error.message ?? error);
      } finally {
        this.starting = false;
        if (!closed) cx.notify();
      }
    });
  }

  command(name, args, cx) {
    try { run(name, args); closeOverlay(props().overlay); }
    catch (error) { this.message = String(error.message ?? error); cx.notify(); }
  }

  key(e, cx) {
    if (this.drag) {
      if (e.key === "escape") { this.cancelDrag(cx); cx.stop_propagation(); }
      return;
    }
    if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt || this.loading || this.loadError || this.starting) return;
    const entries = this.entries();
    if (!entries.length) return;
    if (/^[1-9]$/.test(e.key)) {
      const entry = entries[Number(e.key) - 1];
      if (!entry) return;
      this.start(cx, entry.agent.key, entry.profile.id);
    } else if (e.key === "enter") this.start(cx);
    else if (e.key === "up" || e.key === "down") {
      const index = entries.findIndex(({ agent, profile }) => agent.key === this.selectedAgent && profile.id === this.selectedProfiles[agent.key]);
      const entry = entries[(index + (e.key === "down" ? 1 : -1) + entries.length) % entries.length];
      this.selectProfile(entry.agent.key, entry.profile.id, cx);
    } else return;
    cx.stop_propagation();
  }

  control(id, label, action, { enabled = true, selected = false, icon = null, grip = null, hint = "", full = false, height = 32 } = {}) {
    const t = theme(), focus = this.focuses.get(id);
    return h_flex().id(`launch-${id}`).h(height).px(10).gap(7).flex_none().items_center().rounded(7)
      .when(full, el => el.w_full())
      .bg(selected ? t.raised : t.popover)
      .text_color(enabled ? t.foreground : t.muted).text_size(12.8)
      .border_1().border_color(focus?.is_focused() ? t.accent : selected ? t.input : "#00000000")
      .tab_index(0).when(Boolean(focus), el => el.track_focus(focus))
      .when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
      .on_click((_e, cx) => { if (enabled && !this.drag && !this.dragClick) action(cx); })
      .on_key_down((e, cx) => {
        if (e.key === "enter" || e.key === "space") {
          cx.stop_propagation();
          if (enabled && !this.drag) action(cx);
        }
      })
      .when(Boolean(grip), el => el.child(grip))
      .when(Boolean(icon), el => el.child(icon))
      .child(div().when(full, el => el.flex_1()).max_w(full ? 340 : 170).truncate().child(label))
      .when(Boolean(hint), el => el.child(div().max_w(140).truncate().flex_none().text_size(11).text_color(t.muted).child(hint)));
  }

  render(cx) {
    const t = theme(), entries = this.entries();
    const icon = a => !a.icon ? null : a.tint ? svg(a.icon).size(15).text_color(t.foreground) : image(a.icon).size(15);
    const divider = () => div().h(1).flex_none().mx(2).my(7).bg(t.border);
    let contents = v_flex().min_h(0).min_w(0).gap(2);
    if (this.loading) contents = contents.child(div().px(8).py(18).text_size(13).text_color(t.muted).child("Loading agents and profiles…"));
    else if (this.loadError) contents = contents
      .child(div().px(8).py(12).text_size(12.5).line_height("18px").text_color(t.blocked).child(this.loadError))
      .child(this.control("retry", "Retry", cx => this.reload(cx)));
    else if (!entries.length) contents = contents.child(div().px(8).py(18).text_size(13).text_color(t.muted).child("No available agents or saved profiles."));
    else contents = contents.children(entries.map(({ agent, profile, id }, i) => {
      const selected = agent.key === this.selectedAgent && profile.id === this.selectedProfiles[agent.key];
      const native = profile.id === DEFAULT_PROFILE;
      const grip = div().id(`launch-grip-${rowId(agent.key, profile.id)}`).w(14).h(24).flex_none().flex().items_center().justify_center()
        .text_color(t.dim).cursor_grab().hover(s => s.text_color(t.foreground))
        .on_mouse_down("left", (e, cx) => this.beginDrag(id, e, cx, true))
        .on_click((_e, cx) => cx.stop_propagation())
        .child(svg("mods/agent-profiles/grip.svg").size(12));
      return this.control(rowId(agent.key, profile.id), native ? agent.name : profile.name,
        cx => this.start(cx, agent.key, profile.id), { full: true, height: 34, selected, icon: icon(agent), grip, enabled: !this.starting,
          hint: this.starting && selected ? "Starting…" : `${native ? "Agent" : agent.name}${i < 9 ? ` · ${i + 1}` : ""}` })
        .relative()
        .when(this.drag?.active && this.drag.id === id, el => el.opacity(0.55).cursor_grabbing())
        .when(this.drag?.active && this.drag.target === id && this.drag.id !== id, el => el.child(
          div().absolute().left(0).right(0).h(2).bg(t.accent)
            .when(this.drag.side === "before", line => line.top(0))
            .when(this.drag.side === "after", line => line.bottom(0))))
        .on_mouse_down("left", (e, cx) => this.beginDrag(id, e, cx))
        .on_mouse_move((e, cx) => this.dragOver(id, e, cx))
        .on_mouse_up("left", (e, cx) => this.finishDrag(id, e, cx));
    }));
    contents = contents.when(Boolean(this.message), el => el.child(div().px(8).py(6).text_size(12).line_height("18px").text_color(t.blocked).child(this.message)));
    const bodyHeight = this.loading ? 52 : this.loadError ? 100 : Math.max(44, entries.length * 36 - 2);
    return v_flex().id("agent-profiles-launcher").w_full().h(Math.min(460, 211 + bodyHeight + (this.message ? 64 : 0))).min_h(0).p(8).bg(t.popover)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", (_e, cx) => { this.cancelDrag(cx); this.dragClick = false; })
      .on_mouse_up("left", (_e, cx) => this.cancelDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.cancelDrag(cx); })
      .child(this.control("terminal", "Terminal", cx => this.command("tab.new", this.space ? { space: this.space.id } : {}, cx),
        { full: true, icon: svg("icons/shell.svg").size(15), hint: shortcut("tab.new") }))
      .child(divider())
      .child(h_flex().px(2).pb(5).items_center()
        .child(div().px(8).flex_1().text_size(13).font_medium().text_color(t.foreground).child("Start an agent"))
        .child(this.control("manage", props().returnToManager ? "Back to profiles" : "Edit profiles", () => this.manage())))
      .child(div().id("launcher-content").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().child(contents))
      .child(divider())
      .child(this.control("space", "New space", cx => this.command("space.new", {}, cx), { full: true, icon: div().w(15).child("+") }))
      .child(this.control("worktree", "New worktree…", () => {
        closeOverlay(props().overlay);
        openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: this.space?.id, folder: this.folder, action: "new" } });
      }, { full: true, enabled: Boolean(this.space), icon: svg("mods/agent-profiles/branch.svg").size(15) }))
      .child(this.control("worktree-open", "Open worktree…", () => {
        closeOverlay(props().overlay);
        openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: this.space?.id, folder: this.folder, action: "open" } });
      }, { full: true, enabled: Boolean(this.space), icon: svg("mods/agent-profiles/branch.svg").size(15) }));
  }
}
