// Tokenize arguments without evaluating shell expressions or expanding variables.
export function parseArguments(text) {
  if (text.includes("\0")) throw new Error("Arguments cannot contain a null character.");
  const args = [];
  let word = "", quote = null, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (c === "\\") {
      if (i + 1 === text.length) throw new Error("Finish the escape after the final backslash.");
      const next = text[i + 1];
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next)) word += c;
      else {
        i++;
        if (next !== "\n") { word += next; started = true; }
      }
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) { args.push(word); word = ""; started = false; }
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new Error(`Close the ${quote === "'" ? "single" : "double"} quote.`);
  if (started) args.push(word);
  return args;
}

export function formatArguments(args) {
  return args.map(arg => /^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)
    ? arg : "'" + arg.replace(/'/g, "'\\''") + "'").join(" ");
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function parsePrograms(raw) {
  let config;
  try { config = raw === null ? {} : JSON.parse(raw); }
  catch { throw new Error("programs.json contains invalid JSON. Fix it before saving launch arguments."); }
  if (!isObject(config) || (config.programs !== undefined && !isObject(config.programs))) {
    throw new Error("programs.json and its programs field must be JSON objects.");
  }
  return config;
}

export function agentOverride(config, key) {
  const entry = config.programs?.[key];
  if (entry === undefined) return null;
  if (!isObject(entry)) throw new Error(`The ${key} entry in programs.json must be an object.`);
  if (entry.run === undefined) return null;
  if (!Array.isArray(entry.run) || !entry.run.length || entry.run.some(a => typeof a !== "string") || !entry.run[0]) {
    throw new Error(`The ${key} launch command must be a nonempty array of strings.`);
  }
  return [...entry.run];
}

// Retry unrelated concurrent edits, but never overwrite another edit to this agent.
export async function saveAgentRun({ path, key, argv, previousOverride, read, write }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await read(path);
    const config = parsePrograms(raw);
    if (JSON.stringify(agentOverride(config, key)) !== JSON.stringify(previousOverride)) {
      throw new Error("This agent’s launch command changed elsewhere. Reopen the profile editor to load it.");
    }
    const next = {
      ...config,
      programs: {
        ...config.programs,
        [key]: { ...config.programs?.[key], run: [...argv] },
      },
    };
    try {
      await write(path, JSON.stringify(next, null, 2) + "\n", raw);
      return;
    } catch (error) {
      if (await read(path) === raw) throw error;
    }
  }
  throw new Error("programs.json kept changing. Try saving again.");
}
