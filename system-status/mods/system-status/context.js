export function currentTarget(spaceList, focus, machineList, options = {}) {
  const space = options.space ? spaceList.find(s => s.id === options.space)
    : spaceList.find(s => s.id === focus?.space) ?? spaceList.find(s => s.active);
  if (!space) return { machine: null, name: "", connection: "no-session", space: null };
  const machine = space.machine;
  const info = machineList.find(m => m.name === machine);
  // Only registered cores have an official exec route. Do not inspect the terminal's command/credentials.
  return { machine, name: machine ?? "local", space: space.id,
    connection: info ? info.layout : "unsupported" };
}
export function panelVisible(tree, options, paneList, focus) {
  if (typeof options.visible === "boolean") return options.visible;
  if (options.pane) {
    const pane = paneList.find(p => p.pane === options.pane);
    if (!pane || pane.tab !== focus?.tab) return false;
    const zoomed = paneList.find(p => p.tab === pane.tab && p.zoomed);
    return !zoomed || zoomed.pane === pane.pane;
  }
  let copies = 0, shown = false;
  function visit(node, visible) {
    if (!node || typeof node !== "object") return;
    const active = visible && !node.hidden;
    if ((options.node && node.id === options.node) || (!options.node && node.content?.mod === "system-status")) {
      copies++; shown ||= active;
    }
    for (const child of node.children ?? []) visit(child, active && (node.type !== "stack" || node.active === child.id));
    // Floating drawers lack a universal exposure event; their owner may pass explicit visibility.
  }
  visit(tree, true);
  return copies ? shown : false;
}
