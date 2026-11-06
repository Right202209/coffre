// Synchronous lease arbitration on Herdr shared state, followed by asynchronous IO.
// No JS Promise or native context is put in persisted/shared state.
export const CACHE_MS = 4000, INTERVAL_MS = 5000, BACKOFF_MS = 30000;
export const REQUEST_MS = 10000, HOST_LEASE_MS = 35000;
const keyFor = machine => `system-status.v1:${JSON.stringify(machine)}`;
const identity = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
function fresh(now) {
  return { generation: identity(), connection: "loading", subscribers: {}, sample: null,
    history: [], first: true, error: null, failures: 0, nextAt: now + 2000, busy: null, status: "loading" };
}
function trimSubscribers(s, now) {
  for (const [id, sub] of Object.entries(s.subscribers)) if (now - sub.at > 12000) delete s.subscribers[id];
}

export class Coordinator {
  constructor(store, id = identity(), interval = INTERVAL_MS) {
    this.store = store; this.id = id; this.machine = undefined;
    this.interval = Number.isFinite(interval) ? Math.max(5000, Math.min(60000, interval)) : INTERVAL_MS;
  }
  read(machine = this.machine) { return this.store.get(keyFor(machine)); }
  write(machine, s) { this.store.set(keyFor(machine), s); }
  subscribe(machine, connection, visible, overview, now) {
    if (this.machine !== undefined && this.machine !== machine) this.release(now);
    this.machine = machine;
    let s = this.read() ?? fresh(now);
    trimSubscribers(s, now);
    s.subscribers[this.id] = { at: now, visible, overview };
    if (s.connection !== connection) {
      // Retain presentation history; invalidate old requests and every rate baseline.
      s.generation = identity(); s.connection = connection; s.first = true;
      s.error = null; s.failures = 0; s.nextAt = now + 2000;
      s.status = connection === "ready" ? "loading" : connection;
      // Keep the host execution lease: native exec cannot be cancelled immediately.
    }
    if (!Object.keys(s.subscribers).length) {
      this.write(machine, null); return null;
    }
    this.write(machine, s); return s;
  }
  release(now) {
    const s = this.read();
    if (s) {
      trimSubscribers(s, now); delete s.subscribers[this.id];
      this.write(this.machine, Object.keys(s.subscribers).length ? s : null);
    }
    this.machine = undefined;
  }
  claim(now, retry = false) {
    const s = this.read();
    if (!s || s.connection !== "ready" || (s.status === "unsupported" && !retry)) return null;
    trimSubscribers(s, now);
    if (!Object.values(s.subscribers).some(sub => sub.visible) || (s.busy && now < s.busy.until)) return null;
    if (s.sample && now - s.sample.at >= 0 && now - s.sample.at < CACHE_MS) return null;
    if (!retry && now < s.nextAt) return null;
    const token = { id: identity(), generation: s.generation, machine: this.machine, first: s.first, started: now };
    s.busy = { ...token, until: now + HOST_LEASE_MS, started: now, owner: this.id };
    s.status = s.sample ? "refreshing" : "loading";
    this.write(this.machine, s); return token;
  }
  current(token) {
    if (!token) return false;
    const s = this.read(token.machine);
    return s?.generation === token.generation && s.busy?.id === token.id;
  }
  success(token, sample, now) {
    if (!this.current(token)) return false;
    const s = this.read(token.machine);
    trimSubscribers(s, now);
    if (!Object.keys(s.subscribers).length) { this.write(token.machine, null); return false; }
    s.busy = null; s.error = null; s.failures = 0; s.nextAt = now + this.interval;
    if (sample.unsupported) { s.status = "unsupported"; s.first = true; }
    else {
      if (sample.diskError && s.sample?.disk) sample = { ...sample, disk: s.sample.disk, diskStale: true, partial: true };
      s.sample = sample; s.first = false; s.status = "ready";
      if (Object.values(s.subscribers).some(sub => sub.visible && sub.overview)) {
        s.history.push({ at: sample.at, cpu: sample.cpu.percent, memory: sample.memory?.percent ?? null,
          disk: sample.diskStale ? null : sample.disk?.percent ?? null,
          network: sample.network?.rx == null ? null : sample.network.rx + sample.network.tx });
        s.history = s.history.slice(-24);
      }
    }
    this.write(token.machine, s); return true;
  }
  failure(token, message, now, keepLease = false) {
    if (!this.current(token)) return false;
    const s = this.read(token.machine);
    // No assignment to sample or history: refresh failure preserves the last success.
    s.error = message; s.failures += 1;
    s.status = s.failures >= 3 ? "paused" : "error";
    s.nextAt = now + (s.failures >= 3 ? BACKOFF_MS : this.interval);
    if (keepLease) {
      // Mark the response obsolete, but avoid launching more native exec while it is alive.
      s.busy.id = identity();
    } else s.busy = null;
    this.write(token.machine, s); return true;
  }
  expire(now) {
    const s = this.read();
    if (s?.busy && s.busy.owner === this.id && now - s.busy.started >= REQUEST_MS && s.busy.generation === s.generation) {
      const token = { ...s.busy, machine: this.machine };
      // The changed id prevents repeated failures from the same deadline.
      if (!s.busy.expired) {
        this.failure(token, "timeout", now, true);
        const next = this.read();
        if (next?.busy) { next.busy.expired = true; this.write(this.machine, next); }
      }
    }
  }
  settle(token) {
    // Release a timed-out/obsolete host lease only when its real command has settled.
    const s = this.read(token.machine);
    if (s?.busy?.owner === this.id && s.busy.started === token.started) {
      s.busy = null; this.write(token.machine, s);
    }
  }
}
