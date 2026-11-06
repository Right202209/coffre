export const ORDER = "personal-launcher.order";
export const entryId = (agent, profile) => JSON.stringify([agent, profile]);

function ids(value) {
  return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === "string"))] : [];
}

export function orderedEntries(entries, saved) {
  const rank = new Map(ids(saved).map((id, index) => [id, index]));
  return [...entries].sort((a, b) => (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size));
}

export function moveOrder(entries, saved, source, target, side) {
  const visible = entries.map(entry => entry.id);
  const from = visible.indexOf(source);
  if (from < 0 || source === target || !visible.includes(target) || !["before", "after"].includes(side)) return null;
  const moved = [...visible];
  moved.splice(from, 1);
  moved.splice(moved.indexOf(target) + (side === "after" ? 1 : 0), 0, source);
  if (moved.every((id, index) => id === visible[index])) return null;

  // Keep temporarily unavailable entries in their saved slots.
  const stored = ids(saved), storedSet = new Set(stored), visibleSet = new Set(visible);
  const all = [...stored, ...visible.filter(id => !storedSet.has(id))];
  let index = 0;
  return all.map(id => visibleSet.has(id) ? moved[index++] : id);
}
