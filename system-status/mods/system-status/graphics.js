import { writeFile, mkdir, unlink } from "fs/promises";
import { appHome } from "herdr";
import { ringSvg, trendSvg, networkScale } from "./charts.js";

// GPUI accepts SVG paths, not inline markup. Keep bounded, per-copy generated vectors in data/.
// These writes never touch mods/, so they cannot trigger a mod reload.
export class Graphics {
  constructor(id) { this.id = id; this.sequence = 0; this.sets = []; this.closed = false; }
  async create(sample, history) {
    const seq = ++this.sequence, base = `data/system-status/${this.id}-${seq}`;
    const absolute = path => `${appHome()}/${path}`;
    const values = { cpu: sample.cpu.percent, memory: sample.memory?.percent, disk: sample.disk?.percent,
      network: networkScale(sample.network?.rx == null ? null : sample.network.rx + sample.network.tx) };
    await mkdir(`${appHome()}/data/system-status`, { recursive: true });
    const assets = {}, files = [];
    try {
      for (const key of Object.keys(values)) {
        assets[key] = { ring: `${base}-${key}-ring.svg`, trend: `${base}-${key}-trend.svg` };
        for (const [type, content] of [["ring", ringSvg(values[key])], ["trend", trendSvg(history, key)]]) {
          const path = assets[key][type]; files.push(path);
          await writeFile(absolute(path), content);
        }
      }
      if (this.closed) { await this.remove(files); return null; }
      this.sets.push(files);
      if (this.sets.length > 2) await this.remove(this.sets.shift());
      return assets;
    } catch (error) { await this.remove(files); throw error; }
  }
  async remove(files) { await Promise.allSettled(files.map(path => unlink(`${appHome()}/${path}`))); }
  async close() { this.closed = true; await this.remove(this.sets.flat()); this.sets = []; }
}
