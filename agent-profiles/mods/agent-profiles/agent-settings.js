import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { knownAgents, appHome, readTextFile, writeTextFile, window, spaces, shared, setShared } from "herdr";
import { parseArguments, formatArguments, parsePrograms, agentOverride, saveAgentRun } from "./launch-config.js";
import { PROFILE_FILE, DEFAULT_PROFILE, parseProfiles, agentProfiles, profileName, saveProfile, nextProfileName } from "./profiles.js";
import { ORDER, entryId, orderedEntries, moveOrder } from "./order.js";

const rowId = (agent, profile) => profile === DEFAULT_PROFILE ? `settings-agent-${agent}` : `settings-profile-${entryId(agent, profile)}`;
const dropSide = e => (e.local_position?.y ?? 0) < (e.bounds?.height ?? 46) / 2 ? "before" : "after";

export class AgentSettings {
  constructor(options = {}) {
    this.options = options;
    this.items = null;
    this.loading = false;
    this.error = null;
    this.machine = options.machine === undefined ? spaces().find(s => s.active)?.machine ?? null : options.machine;
    this.query = "";
    this.drag = null;
    this.dragClick = false;
    this.compact = false;
  }

  load(cx) {
    if (this.items !== null || this.loading) return;
    this.loading = true;
    this.error = null;
    this.addFocus = cx.focus_handle();
    this.retryFocus = cx.focus_handle();
    this.bodyFocus = cx.focus_handle();
    this.listFocus = cx.focus_handle();
    this.searchInput = InputState.new({ placeholder: "Search agents and profiles" });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value();
      this.cancelDrag(cx);
      const visible = this.visibleEntries();
      if (visible.length && !visible.some(e => e.agent.key === this.selected && e.profile.id === this.currentProfile()?.id)) {
        this.select(visible[0], cx, false);
      }
      cx.notify();
    });
    cx.spawn(async cx => {
      try {
        const [agents, raw, profileRaw] = await Promise.all([
          knownAgents({ on: this.machine }), readTextFile(`${appHome()}/programs.json`), readTextFile(`${appHome()}/${PROFILE_FILE}`),
        ]);
        const programs = parsePrograms(raw), profiles = parseProfiles(profileRaw);
        this.items = agents.filter(a => Array.isArray(a.run) && a.run.length)
          .map(agent => {
            const override = agentOverride(programs, agent.key), argv = override ?? agent.run;
            const item = { ...agent, command: argv[0], override, profiles: [], selected: DEFAULT_PROFILE };
            item.profiles = [
              this.makeProfile(item, { id: DEFAULT_PROFILE, name: "Default", args: argv.slice(1) }, null, cx),
              ...agentProfiles(profiles, agent.key).map(record => this.makeProfile(item, record, record, cx)),
            ];
            for (const p of item.profiles) this.validate(item, p);
            return item;
          });
        const entries = this.entries();
        const selected = entries.find(e => e.agent.key === this.options.agent && e.profile.id === this.options.profile)
          ?? entries.find(e => e.agent.key === this.options.agent) ?? entries[0];
        if (selected) this.select(selected, cx, false);
      } catch (error) {
        this.items = null;
        this.error = String(error.message ?? error);
      }
      this.loading = false;
      cx.notify();
    });
  }

  current() { return this.items?.find(item => item.key === this.selected); }
  currentProfile(item = this.current()) { return item?.profiles.find(p => p.id === item.selected); }

  order() { return shared(ORDER)?.[this.machine ?? ""]; }
  entries() {
    const items = this.items ?? [];
    const entry = (agent, profile) => ({ agent, profile, id: entryId(agent.key, profile.id) });
    const agents = items.filter(a => a.installed).map(a => entry(a, a.profiles[0]));
    const profiles = items.flatMap(a => a.profiles.filter(p => p.id !== DEFAULT_PROFILE).map(p => entry(a, p)));
    return orderedEntries([...agents, ...profiles], this.order());
  }

  visibleEntries() {
    const terms = this.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.entries().filter(({ agent, profile }) => {
      // Keep a matching saved name while renaming a filtered profile.
      const name = profile.id === DEFAULT_PROFILE ? "" : `${profile.savedName} ${profile.nameInput.value()}`;
      const text = `${agent.name} ${agent.key} ${name} ${agent.installed ? "" : "unavailable"}`.toLowerCase();
      return terms.every(term => text.includes(term));
    });
  }

  select(entry, cx, focus = true) {
    if (this.drag) return;
    this.selected = entry.agent.key;
    entry.agent.selected = entry.profile.id;
    if (focus) entry.profile.focus.focus();
    cx.notify();
  }

  listKey(e, cx) {
    if (this.drag) {
      if (e.key === "escape") { this.cancelDrag(cx); cx.stop_propagation(); }
      return;
    }
    if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt || !["up", "down"].includes(e.key)) return;
    const entries = this.visibleEntries();
    if (!entries.length) return;
    const index = entries.findIndex(({ agent, profile }) => agent.key === this.selected && profile.id === this.currentProfile()?.id);
    this.select(entries[(index + (e.key === "down" ? 1 : -1) + entries.length) % entries.length], cx);
    cx.stop_propagation();
  }

  beginDrag(id, e, cx, grip = false) {
    if (!this.entries().some(entry => entry.id === id)) return;
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
    this.dragClick = true;
    if (drag.active) {
      const next = moveOrder(this.entries(), this.order(), drag.id, id, dropSide(e));
      if (next) {
        const value = shared(ORDER);
        const saved = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        setShared(ORDER, { ...saved, [this.machine ?? ""]: next });
      }
    } else if (!drag.grip && drag.id === id) {
      const entry = this.entries().find(e => e.id === id);
      if (entry) this.select(entry, cx);
    }
    cx.notify();
  }

  cancelDrag(cx) {
    if (!this.drag) return;
    this.dragClick = this.drag.active || this.drag.grip;
    this.drag = null;
    cx.notify();
  }

  makeProfile(item, record, snapshot, cx) {
    const profile = {
      id: record.id, snapshot, savedName: record.name, savedText: formatArguments(record.args),
      args: [...record.args], saving: false, error: null, notice: null, pendingRemove: false,
      focus: cx.focus_handle(), controls: {},
    };
    for (const name of ["save", "duplicate", "remove", "cancel", "confirm"]) profile.controls[name] = cx.focus_handle();
    profile.nameInput = InputState.new({ value: record.name, placeholder: "Profile name" });
    profile.input = TextareaState.new({ value: profile.savedText, rows: 4, placeholder: "Enter launch arguments" });
    const changed = (_e, cx) => {
      profile.notice = null;
      profile.error = null;
      profile.pendingRemove = false;
      this.validateAll(item);
      cx.notify();
    };
    for (const [input, key] of [[profile.input, "argsFocused"], [profile.nameInput, "nameFocused"]]) {
      input.on("change", changed);
      input.on("focus", (_e, cx) => { profile[key] = true; cx.notify(); });
      input.on("blur", (_e, cx) => { profile[key] = false; cx.notify(); });
    }
    profile.nameInput.on("submit", (_e, cx) => this.save(item, profile, cx));
    profile.input.on("submit", (e, cx) => { if (e.secondary) this.save(item, profile, cx); });
    return profile;
  }

  validate(item, profile) {
    try { profile.args = parseArguments(profile.input.value()); profile.parseError = null; }
    catch (error) { profile.args = null; profile.parseError = error.message; }
    profile.nameError = null;
    if (profile.id !== DEFAULT_PROFILE) {
      try { profileName(profile.nameInput.value(), item.profiles.map(p => ({ id: p.id, name: p.nameInput.value() })), profile.id); }
      catch (error) { profile.nameError = error.message; }
    }
  }

  validateAll(item) { for (const profile of item.profiles) this.validate(item, profile); }

  dirty(profile) {
    return (profile.id !== DEFAULT_PROFILE && profile.snapshot === null)
      || profile.input.value() !== profile.savedText || profile.nameInput.value() !== profile.savedName;
  }

  add(item, source, cx, duplicate = false) {
    const names = item.profiles.map(p => ({ id: p.id, name: p.nameInput.value() }));
    const base = duplicate ? `${source.id === DEFAULT_PROFILE ? item.name : source.nameInput.value()} copy` : "New profile";
    let id;
    do { id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
    while (item.profiles.some(p => p.id === id));
    const profile = this.makeProfile(item, {
      id, name: nextProfileName(base, names), args: source.args ?? parseArguments(source.savedText),
    }, null, cx);
    item.profiles.push(profile);
    if (duplicate) profile.input.set_value(source.input.value());
    item.selected = id;
    this.selected = item.key;
    this.query = "";
    this.searchInput.set_value("");
    this.validateAll(item);
    profile.nameInput.set_selected_range({ start: 0, end: profile.nameInput.value().length });
    profile.nameInput.focus();
    cx.notify();
  }

  save(item, profile, cx) {
    this.validate(item, profile);
    if (profile.saving || profile.parseError || profile.nameError || !this.dirty(profile)) return;
    const text = profile.input.value(), name = profile.nameInput.value().trim(), args = [...profile.args];
    profile.saving = true;
    profile.error = null;
    profile.notice = null;
    profile.pendingRemove = false;
    cx.notify();
    cx.spawn(async cx => {
      try {
        if (profile.id === DEFAULT_PROFILE) {
          const argv = [item.command, ...args];
          await saveAgentRun({
            path: `${appHome()}/programs.json`, key: item.key, argv,
            previousOverride: item.override, read: readTextFile, write: writeTextFile,
          });
          item.override = argv;
        } else {
          profile.snapshot = await saveProfile({
            path: `${appHome()}/${PROFILE_FILE}`, key: item.key, id: profile.id,
            profile: { id: profile.id, name, args }, previous: profile.snapshot,
            read: readTextFile, write: writeTextFile,
          });
        }
        // Keep any newer name or argument edits made while the write was pending.
        const originalName = profile.nameInput.value();
        if (originalName.trim() === name) profile.nameInput.set_value(name);
        profile.savedName = name;
        profile.savedText = text;
        this.validateAll(item);
        profile.notice = this.dirty(profile) ? null : "Saved";
      } catch (error) {
        profile.error = String(error.message ?? error);
      }
      profile.saving = false;
      cx.notify();
    });
  }

  remove(item, profile, cx) {
    if (profile.id === DEFAULT_PROFILE || profile.saving) return;
    const finish = cx => {
      item.profiles = item.profiles.filter(p => p.id !== profile.id);
      const removed = entryId(item.key, profile.id);
      if (this.drag?.id === removed || this.drag?.target === removed) this.cancelDrag(cx);
      if (item.selected === profile.id) item.selected = item.installed ? DEFAULT_PROFILE : (item.profiles[1]?.id ?? DEFAULT_PROFILE);
      this.validateAll(item);
      if (!this.entries().some(e => e.agent.key === this.selected && e.profile.id === this.currentProfile()?.id)) {
        const first = this.entries()[0];
        if (first) this.select(first, cx);
      }
    };
    if (profile.snapshot === null) { finish(cx); cx.notify(); return; }
    if (!profile.pendingRemove) { profile.pendingRemove = true; cx.notify(); return; }
    profile.saving = true;
    profile.error = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        await saveProfile({ path: `${appHome()}/${PROFILE_FILE}`, key: item.key, id: profile.id,
          profile: null, previous: profile.snapshot, read: readTextFile, write: writeTextFile });
        finish(cx);
      } catch (error) { profile.error = String(error.message ?? error); }
      profile.saving = false;
      cx.notify();
    });
  }

  button(t, id, label, enabled, action, focus, primary = false) {
    return h_flex().id(id).h(34).px(12).flex_none().items_center().justify_center().rounded(7)
      .border_1().border_color(focus?.is_focused() ? t.accent : primary && enabled ? t.solid : t.input)
      .bg(primary && enabled ? t.solid : enabled ? t.raised : t.popover)
      .text_size(13).text_color(primary && enabled ? t.solid_foreground : enabled ? t.foreground : t.muted)
      .tab_index(0).when(Boolean(focus), el => el.track_focus(focus))
      .when(enabled, el => el.cursor_pointer().hover(s => s.opacity(0.88)))
      .on_click((_e, cx) => { if (enabled && !this.drag && !this.dragClick) action(cx); })
      .on_key_down((e, cx) => {
        if (enabled && !this.drag && (e.key === "enter" || e.key === "space")) { cx.stop_propagation(); action(cx); }
      }).child(label);
  }

  icon(t, agent) {
    return !agent.icon ? null : agent.tint ? svg(agent.icon).size(16).text_color(t.foreground) : image(agent.icon).size(16);
  }

  row(t, entry) {
    const { agent, profile, id } = entry;
    const native = profile.id === DEFAULT_PROFILE, selected = agent.key === this.selected && profile.id === this.currentProfile()?.id;
    const icon = this.icon(t, agent);
    const grip = div().id(`settings-grip-${id}`).w(12).h(28).flex_none().flex().items_center().justify_center()
      .text_color(t.dim).cursor_grab().hover(s => s.text_color(t.foreground))
      .on_mouse_down("left", (e, cx) => this.beginDrag(id, e, cx, true))
      .on_click((_e, cx) => cx.stop_propagation())
      .child(svg("mods/agent-profiles/grip.svg").size(12));
    return h_flex().id(rowId(agent.key, profile.id)).w_full().h(46).px(7).gap(6).flex_none().items_center().relative().rounded(7)
      .bg(selected ? t.raised : t.popover).border_1().border_color(selected || profile.focus.is_focused() ? t.input : "#00000000")
      .cursor_pointer().hover(s => s.bg(t.hover)).track_focus(profile.focus).tab_index(0)
      .on_click((_e, cx) => { if (!this.drag && !this.dragClick) this.select(entry, cx); })
      .on_key_down((e, cx) => {
        if (!this.drag && ["enter", "space"].includes(e.key)) { cx.stop_propagation(); this.select(entry, cx); }
      })
      .on_mouse_down("left", (e, cx) => this.beginDrag(id, e, cx))
      .on_mouse_move((e, cx) => this.dragOver(id, e, cx))
      .on_mouse_up("left", (e, cx) => this.finishDrag(id, e, cx))
      .when(this.drag?.active && this.drag.id === id, el => el.opacity(0.55).cursor_grabbing())
      .when(this.drag?.active && this.drag.target === id && this.drag.id !== id, el => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.drag.side === "before", line => line.top(0)).when(this.drag.side === "after", line => line.bottom(0))))
      .child(grip).when(Boolean(icon), el => el.child(icon))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(12.5).text_color(t.foreground).child(native ? agent.name : profile.nameInput.value().trim() || "New profile"))
        .child(div().truncate().text_size(10.5).text_color(t.muted).child(native ? "Agent" : `${agent.name}${agent.installed ? "" : " · unavailable"}`)))
      .when(this.dirty(profile), el => el.child(div().size(5).flex_none().rounded(3).bg(t.accent)));
  }

  list(t, entries, selectedVisible) {
    const agents = (this.items ?? []).filter(a => a.installed).length;
    const profiles = (this.items ?? []).reduce((sum, a) => sum + a.profiles.filter(p => p.id !== DEFAULT_PROFILE && p.snapshot !== null).length, 0);
    const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
    return v_flex().id("settings-agent-browser").min_h(0).min_w(0).p(10).gap(10).border_1().border_color(t.border).rounded(8)
      .track_focus(this.listFocus).on_key_down((e, cx) => this.listKey(e, cx))
      .child(div().text_size(11.5).text_color(t.muted).child(`${count(agents, "agent")} · ${count(profiles, "profile")}`))
      .child(Input.new(this.searchInput).id("settings-agent-search").w_full().min_w(0).h(36).px(8).rounded(7)
        .border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground).tab_index(0))
      .child(v_flex().id("settings-agent-list").flex_1().min_h(0).min_w(0).gap(2).overflow_y_scrollbar()
        .on_mouse_up("left", (_e, cx) => this.cancelDrag(cx))
        .on_hover((hovered, cx) => { if (!hovered) this.cancelDrag(cx); })
        .children(entries.map(e => this.row(t, e)))
        .when(!entries.length, el => el.child(div().px(7).py(16).text_size(12).line_height("18px").text_color(t.muted).child("No matching agents or profiles."))))
      .child(this.button(t, "profile-add", "+ New profile", selectedVisible,
        cx => this.add(this.current(), this.current().profiles[0], cx), this.addFocus).w_full());
  }

  editor(t, item, profile) {
    const isDefault = profile.id === DEFAULT_PROFILE;
    const error = profile.parseError ?? profile.nameError ?? profile.error;
    const saved = !this.dirty(profile);
    const saveKey = window()?.platform === "macos" ? "Cmd+Enter" : "Ctrl+Enter";
    const inputStyle = (el, focused, invalid) => el.w_full().min_w(0).px(10).rounded(7).border_1()
      .border_color(invalid ? t.blocked : focused ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground).tab_index(0);
    const label = text => div().pt(14).pb(7).text_size(13).font_medium().child(text);
    const icon = this.icon(t, item);
    const form = v_flex().id("settings-profile-form").flex_1().min_h(0).min_w(0).p(14).overflow_y_scrollbar()
      .child(h_flex().gap(8).items_center().min_w(0)
        .when(Boolean(icon), el => el.child(icon))
        .child(div().flex_1().min_w(0).truncate().text_size(18).font_semibold().child(isDefault ? item.name : profile.nameInput.value().trim() || "New profile")))
      .child(div().pt(4).text_size(12.5).text_color(t.muted).child(isDefault ? "Default launch arguments" : `Profile for ${item.name}`))
      .when(!item.installed, el => el.child(div().pt(8).text_size(12).text_color(t.muted).child("Not available on this device")))
      .when(!isDefault, el => el.child(label("Profile name"))
        .child(inputStyle(Input.new(profile.nameInput).id(`profile-name-${profile.id}`).h(36), profile.nameFocused, profile.nameError)))
      .child(h_flex().pt(14).pb(7).items_center()
        .child(div().flex_1().text_size(13).font_medium().child("Arguments"))
        .child(div().text_size(11.5).text_color(t.muted).child(`${saveKey} saves`)))
      .child(inputStyle(Textarea.new(profile.input).id(`profile-args-${profile.id}`).h(116).py(8), profile.argsFocused, profile.parseError))
      .child(div().pt(7).text_size(12).line_height("18px").text_color(t.muted)
        .child("Use absolute paths. Quote paths with spaces."))
      .child(label("Command preview"))
      .child(div().id(`profile-command-${profile.id}`).w_full().min_w(0).flex_none().whitespace_normal().p(10).rounded(7).bg(t.background)
        .font_family("JetBrains Mono").text_size(11.5).line_height("18px").text_color(t.foreground)
        .child(profile.args ? formatArguments([item.command, ...profile.args]) : "Fix the arguments to preview the command."))
      .child(div().pt(8).text_size(12).text_color(t.muted)
        .child(`Tab name: ${isDefault ? item.name : profile.nameInput.value().trim() || "Unnamed profile"}`));
    const footer = v_flex().flex_none().min_w(0).p(12).border_t(1).border_color(t.border)
      .when(Boolean(error || profile.notice || !saved), el => el.child(div().pb(8).text_size(12).line_height("18px")
        .text_color(error ? t.blocked : t.muted).child(error || profile.notice || "Unsaved changes")))
      .when(profile.pendingRemove, el => el.child(h_flex().gap(6).items_center().flex_wrap()
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(`Remove “${profile.snapshot?.name}”?`))
        .child(this.button(t, "profile-remove-cancel", "Cancel", !profile.saving,
          cx => { profile.pendingRemove = false; cx.notify(); }, profile.controls.cancel))
        .child(this.button(t, "profile-remove-confirm", profile.saving ? "Removing…" : "Remove", !profile.saving,
          cx => this.remove(item, profile, cx), profile.controls.confirm))))
      .when(!profile.pendingRemove, el => el.child(h_flex().gap(6).items_center().flex_wrap()
        .child(this.button(t, "profile-duplicate", "Duplicate", !profile.saving,
          cx => this.add(item, profile, cx, true), profile.controls.duplicate))
        .when(!isDefault, row => row.child(this.button(t, "profile-remove", profile.snapshot === null ? "Discard" : "Remove", !profile.saving,
          cx => this.remove(item, profile, cx), profile.controls.remove)))
        .child(div().flex_1())
        .child(this.button(t, "profile-save", profile.saving ? "Saving…" : isDefault ? "Save arguments" : "Save profile", !saved && !profile.saving && !profile.parseError && !profile.nameError,
          cx => this.save(item, profile, cx), profile.controls.save, true))));
    return v_flex().id("settings-profile-editor").min_w(0).min_h(0).rounded(8).border_1().border_color(t.border).overflow_hidden()
      .child(form).child(footer);
  }

  render(t, toolbar = null) {
    const visible = this.visibleEntries(), item = this.current(), profile = this.currentProfile(item);
    const selectedVisible = visible.some(e => e.agent === item && e.profile === profile);
    const body = v_flex().id("agent-settings-body").w_full().min_w(0).text_color(t.foreground)
      .when(Boolean(this.bodyFocus), el => el.track_focus(this.bodyFocus))
      .on_size_change((size, cx) => {
        const compact = size.width < 560;
        if (compact !== this.compact) { this.compact = compact; cx.notify(); }
      })
      .on_mouse_down("left", (_e, cx) => { this.cancelDrag(cx); this.dragClick = false; })
      .on_key_down((e, cx) => {
        if (this.drag && e.key === "escape") { this.cancelDrag(cx); cx.stop_propagation(); }
        else if (selectedVisible && e.key === "enter" && (e.modifiers.control || e.modifiers.platform)) {
          cx.stop_propagation(); this.save(item, profile, cx);
        }
      })
      .child(h_flex().min_w(0).gap(8).items_center()
        .child(div().flex_1().text_size(20).font_semibold().child("Agents"))
        .when(Boolean(toolbar), el => el.child(toolbar)))
      .child(div().pt(8).pb(16).text_size(13).line_height("19px").text_color(t.muted).child("Manage launch arguments and saved profiles."));
    if (this.loading) return body.child(div().py(20).text_size(13).text_color(t.muted).child("Loading agents…"));
    if (this.error) return body.child(div().py(16).text_size(13).text_color(t.blocked).child(this.error))
      .child(this.button(t, "agent-settings-retry", "Retry", true, cx => this.load(cx), this.retryFocus));
    if (!this.entries().length) return body.child(div().py(20).text_size(13).text_color(t.muted).child("No agents or saved profiles are available on this device."));
    const list = this.list(t, visible, selectedVisible).flex_none().h(this.compact ? 240 : 492)
      .when(this.compact, el => el.w_full()).when(!this.compact, el => el.w(212));
    const editor = selectedVisible ? this.editor(t, item, profile) : v_flex().min_w(0).rounded(8).border_1().border_color(t.border)
      .p(18).text_size(13).text_color(t.muted).child("Select an agent or profile to edit.");
    const panels = this.compact ? v_flex().id("agent-settings-panels").w_full().gap(16) : h_flex().id("agent-settings-panels").w_full().min_w(0).h(492).gap(18);
    return body.child(panels.child(list).child(editor.h(492).when(this.compact, el => el.w_full()).when(!this.compact, el => el.flex_1())));
  }
}
