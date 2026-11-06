import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, openOverlay, closeOverlay } from "herdr";
import AgentLauncher from "./launcher.js";
import { AgentSettings } from "./agent-settings.js";

export default class AgentProfiles extends AgentLauncher {
  init(initialProps, cx) {
    const options = props() ?? {};
    this.view = options.view === "launcher" ? "launcher" : "profiles";
    if (this.view === "launcher") { super.init(initialProps, cx); return; }
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.launcherFocus = cx.focus_handle();
    this.closeFocus = cx.focus_handle();
    this.editor = new AgentSettings({ agent: options.agent, profile: options.profile, machine: options.machine });
    this.editor.load(cx);
  }

  openLauncher() {
    openOverlay({ mod: "agent-profiles", kind: "popup", width: 440, height: 480,
      props: { view: "launcher", returnToManager: Boolean(props()?.overlay) } });
  }

  closeManager() {
    const overlay = props()?.overlay;
    if (typeof overlay === "string") closeOverlay(overlay);
  }

  render(cx) {
    if (this.view === "launcher") return super.render(cx);
    const t = theme();
    const toolbar = h_flex().gap(6).items_center()
      .child(this.editor.button(t, "agent-profiles-open-launcher", "Open launcher", true,
        () => this.openLauncher(), this.launcherFocus))
      .when(typeof props()?.overlay === "string", el => el.child(this.editor.button(t, "agent-profiles-close", "Close", true,
        () => this.closeManager(), this.closeFocus)));
    return v_flex().id("agent-profiles-manager").w_full().h(620).min_w(0).min_h(0).bg(t.popover)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.editor.drag) this.editor.cancelDrag(cx);
          else this.closeManager();
          cx.stop_propagation();
        } else if (e.key === "enter" && (e.modifiers.control || e.modifiers.platform)) {
          const item = this.editor.current(), profile = this.editor.currentProfile(item);
          if (this.editor.visibleEntries().some(entry => entry.agent === item && entry.profile === profile)) {
            this.editor.save(item, profile, cx); cx.stop_propagation();
          }
        }
      })
      .child(v_flex().id("agent-profiles-scroll").flex_1().min_w(0).min_h(0).overflow_y_scrollbar()
        .child(div().p(20).min_w(0).child(this.editor.render(t, toolbar))));
  }
}
