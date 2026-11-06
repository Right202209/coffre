// Minimal host state for controller tests. Rendering is checked by herdr-app.
export const host = { calls: [], spaces: [], saved: {}, handler: null };
export const hc = args => { host.calls.push(args); return host.handler(args); };
export const spaces = () => host.spaces;
export const shared = key => host.saved[key];
export const setShared = (key, value) => { host.saved[key] = value; };
export const div = () => { throw new Error("Use the native renderer for UI tests"); };
export const svg = div, h_flex = div, v_flex = div, v_virtual_list = div;
export const Scrollbar = {}, Input = {};
export const InputState = {
  new(options = {}) {
    return { text: options.value ?? "", events: {}, focused: false, released: false,
      value() { return this.text; }, set_value(value) { this.text = value; },
      on(event, handler) { this.events[event] = handler; }, focus() { this.focused = true; }, release() { this.released = true; } };
  },
};
export const VirtualListScrollHandle = { new: () => ({ scroll_to_item() {}, release() {} }) };
export function context() {
  const tasks = [];
  return { tasks, notices: 0, clipboard: "", notify() { this.notices++; },
    focus_handle: () => ({ focus() {}, release() {}, is_focused: () => false }),
    spawn(body) { const task = Promise.resolve().then(() => body(this)); tasks.push(task); return task; },
    write_to_clipboard(text) { this.clipboard = text; },
    async settle() { while (tasks.length) await Promise.all(tasks.splice(0)); },
  };
}
