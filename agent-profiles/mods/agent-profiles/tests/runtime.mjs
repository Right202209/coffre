import { registerHooks } from "node:module";

export const runtime = {};
globalThis.__herdrProfilesTest = runtime;
registerHooks({
  resolve(specifier, context, next) {
    if (["gpui-kit", "gpui-base", "herdr"].includes(specifier)) return { url: `herdr-test:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    const names = {
      "herdr-test:gpui-kit": ["div", "svg", "image"],
      "herdr-test:gpui-base": ["h_flex", "v_flex", "InputState", "Input", "TextareaState", "Textarea"],
      "herdr-test:herdr": ["knownAgents", "appHome", "readTextFile", "writeTextFile", "window", "spaces", "panes", "theme", "run", "openOverlay", "closeOverlay", "props", "shared", "setShared", "keys"],
    }[url];
    if (!names) return next(url, context);
    return { format: "module", shortCircuit: true,
      source: (url.endsWith("gpui-kit") ? "export class View {}\n" : "") + names.map(name => ["InputState", "Input", "TextareaState", "Textarea"].includes(name)
        ? `export const ${name} = { new: (...args) => globalThis.__herdrProfilesTest.${name}.new(...args) };`
        : `export const ${name} = (...args) => globalThis.__herdrProfilesTest.${name}(...args);`).join("\n"),
    };
  },
});

export function element(kind, state = null) {
  const data = { kind, state, attrs: {}, handlers: {}, nodes: [] };
  let proxy;
  proxy = new Proxy(data, { get(target, key) {
    if (key in target) return target[key];
    if (key === "then") return undefined;
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key === "child") target.nodes.push(args[0]);
      else if (key === "children") target.nodes.push(...args[0]);
      else if (key.startsWith("on_")) target.handlers[key] = args.at(-1);
      else target.attrs[key] = args.length === 1 ? args[0] : args;
      return proxy;
    };
  } });
  return proxy;
}

export function findElement(root, id) {
  if (!root || typeof root !== "object") return null;
  if (root.attrs?.id === id) return root;
  for (const child of root.nodes ?? []) { const found = findElement(child, id); if (found) return found; }
  return null;
}

export function fixture({ programs = null, profiles = null, agents, selection = null } = {}) {
  const pending = [], writes = [], calls = [], overlays = [], closed = [], shared = new Map();
  const files = new Map([
    ["programs.json", programs === null ? null : typeof programs === "string" ? programs : JSON.stringify(programs)],
    ["agent-launch-profiles.json", profiles === null ? null : typeof profiles === "string" ? profiles : JSON.stringify(profiles)],
  ]);
  if (selection) shared.set("personal-launcher.selection", selection);
  const agentList = agents ?? [
    { key: "claude", name: "Claude Code", installed: true, run: ["claude"], icon: null },
    { key: "codex", name: "Codex", installed: true, run: ["codex"], icon: null },
  ];
  const spaceList = [{ id: "space-a", active: true, machine: "remote" }];
  const cx = { notify() {}, stop_propagation() {},
    focus_handle: () => ({ is_focused: () => false, focus() {} }),
    spawn(fn) { pending.push(fn(cx)); },
  };
  const makeInput = ({ value = "" } = {}) => {
    const handlers = {};
    return { value: () => value,
      set_value(text) { value = text; },
      edit_value(text) { value = text; handlers.change?.({}, cx); },
      on(event, handler) { handlers[event] = handler; return true; },
      submit(event = { secondary: true }) { handlers.submit?.(event, cx); },
      set_selected_range() {}, focus() {},
    };
  };
  Object.assign(runtime, {
    knownAgents: async () => agentList,
    appHome: () => "/test/herdr",
    readTextFile: async path => files.get(path.split("/").pop()) ?? null,
    writeTextFile: async (path, next, expected) => {
      const name = path.split("/").pop();
      if ((files.get(name) ?? null) !== expected) throw new Error("stale snapshot");
      files.set(name, next); writes.push({ name, next });
    },
    window: () => ({ platform: "linux" }), spaces: () => spaceList,
    panes: () => [{ focused: true, cwd: "/repo" }],
    props: () => ({ overlay: "launcher-overlay" }),
    shared: key => shared.get(key), setShared: (key, value) => shared.set(key, value),
    theme: () => new Proxy({}, { get: () => "#aaaaaa" }),
    keys: () => [{ section: "global", keys: "ctrl-shift-t", action: "tab.new" }],
    run: (name, args) => { calls.push({ name, args }); return null; },
    openOverlay: options => { overlays.push(options); return "settings-overlay"; },
    closeOverlay: id => { closed.push(id); },
    div: () => element("div"), svg: path => element("svg", path), image: path => element("image", path),
    h_flex: () => element("h_flex"), v_flex: () => element("v_flex"),
    InputState: { new: makeInput }, TextareaState: { new: makeInput },
    Input: { new: state => element("input", state) }, Textarea: { new: state => element("textarea", state) },
  });
  return { files, writes, calls, overlays, closed, shared, agents: agentList, spaces: spaceList, cx,
    async flush() { while (pending.length) await Promise.all(pending.splice(0)); },
    json(name = "agent-launch-profiles.json") { return JSON.parse(files.get(name)); },
  };
}

export const sampleProfiles = () => ({ version: 1, agents: {
  claude: { profiles: [
    { id: "work", name: "Work", args: ["--settings", "/profiles/work settings.json", "--model", "sonnet"] },
    { id: "review", name: "Review", args: ["--settings", "/profiles/review.json", "--verbose"] },
  ] },
} });
