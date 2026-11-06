// Saved data is compatible with the personal launcher mods.
import { agentOverride } from "./launch-config.js";

export const PROFILE_FILE = "agent-launch-profiles.json";
export const DEFAULT_PROFILE = "default";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function profileName(name, profiles = [], id = null) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value) throw new Error("Give this profile a name.");
  if ([...value].length > 64) throw new Error("Use a profile name of 64 characters or fewer.");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Profile names must stay on one line.");
  if (value.toLowerCase() === "default") throw new Error("Default is reserved for the agent’s current command.");
  if (profiles.some(p => p.id !== id && p.name.trim().toLowerCase() === value.toLowerCase())) {
    throw new Error("This agent already has a profile with that name.");
  }
  return value;
}

function validProfile(profile) {
  if (!object(profile) || typeof profile.id !== "string" || !profile.id || profile.id === DEFAULT_PROFILE || /[\u0000-\u001f\u007f]/.test(profile.id)) {
    throw new Error("Each saved profile needs a unique id other than default.");
  }
  profileName(profile.name);
  if (!Array.isArray(profile.args) || profile.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("Profile arguments must be an array of strings without null characters.");
  }
}

export function parseProfiles(raw) {
  let config;
  try { config = raw === null ? { version: 1, agents: {} } : JSON.parse(raw); }
  catch { throw new Error(`${PROFILE_FILE} contains invalid JSON. Fix it before using profiles.`); }
  if (!object(config) || config.version !== 1 || !object(config.agents)) {
    throw new Error(`${PROFILE_FILE} must contain version 1 and an agents object.`);
  }
  for (const entry of Object.values(config.agents)) {
    if (!object(entry) || !Array.isArray(entry.profiles)) throw new Error("Each agent’s profiles must be an array.");
    const ids = new Set(), names = new Set();
    for (const profile of entry.profiles) {
      validProfile(profile);
      const name = profile.name.trim().toLowerCase();
      if (ids.has(profile.id) || names.has(name)) throw new Error("Profile ids and names must be unique within each agent.");
      ids.add(profile.id);
      names.add(name);
    }
  }
  return config;
}

export function agentProfiles(config, key) {
  return (config.agents[key]?.profiles ?? []).map(p => ({ ...p, args: [...p.args] }));
}

export function launchChoices(agents, programs, profiles) {
  return agents.filter(agent => Array.isArray(agent.run) && agent.run.length).map(agent => {
    const argv = agentOverride(programs, agent.key) ?? agent.run;
    return {
      ...agent, run: [...argv],
      profiles: [
        { id: DEFAULT_PROFILE, name: "Default", args: argv.slice(1), argv: [...argv], tabName: agent.name },
        ...agentProfiles(profiles, agent.key).map(profile => ({
          ...profile, name: profile.name.trim(), argv: [argv[0], ...profile.args], tabName: profile.name.trim(),
        })),
      ],
    };
  });
}

export function findLaunch(choices, agentKey, profileId) {
  const agent = choices.find(a => a.key === agentKey);
  const profile = agent?.profiles.find(p => p.id === profileId);
  if (!agent || !profile) throw new Error("This launch profile no longer exists. Choose another profile.");
  if (!agent.installed) throw new Error(`${agent.name} is not installed on this machine.`);
  return { agent, profile };
}

// A profile's stable id survives renames. Concurrent changes to other profiles merge.
// Passing profile: null deletes only the matching, unchanged saved profile.
export async function saveProfile({ path, key, id, profile, previous, read, write }) {
  if (!id || id === DEFAULT_PROFILE) throw new Error("The Default profile cannot be removed or renamed.");
  if (profile) { validProfile(profile); if (profile.id !== id) throw new Error("Profile ids do not match."); }
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await read(path);
    const config = parseProfiles(raw);
    const list = agentProfiles(config, key);
    const current = list.find(p => p.id === id) ?? null;
    if (!same(current, previous)) throw new Error("This profile changed elsewhere. Reopen the profile editor to load it.");
    let saved = null;
    if (profile) {
      saved = { ...current, id, name: profileName(profile.name, list, id), args: [...profile.args] };
    }
    const nextList = saved
      ? current ? list.map(p => p.id === id ? saved : p) : [...list, saved]
      : list.filter(p => p.id !== id);
    const next = {
      ...config,
      agents: { ...config.agents, [key]: { ...config.agents[key], profiles: nextList } },
    };
    try {
      await write(path, JSON.stringify(next, null, 2) + "\n", raw);
      return saved;
    } catch (error) {
      if (await read(path) === raw) throw error;
    }
  }
  throw new Error("Launch profiles kept changing. Try saving again.");
}

export function nextProfileName(base, profiles) {
  const stem = base.trim().slice(0, 52) || "New profile";
  let name = stem, number = 2;
  while (profiles.some(p => p.name.trim().toLowerCase() === name.toLowerCase()) || name.toLowerCase() === "default") {
    name = `${stem} ${number++}`;
  }
  return name;
}
