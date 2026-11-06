/** Mod types, not replacements for Herdr's generated SDK declarations. */
export interface ModOptions {
  /** Layout node id; required to disambiguate multiple copies and expose the hide button. */
  node?: string;
  /** Optional bound space. Otherwise follows focused()/active space. */
  space?: string;
  /** Explicit exposure supplied by an overlay owner. */
  visible?: boolean;
  pane?: string;
  language?: "zh" | "en";
  /** 5–60 seconds; Herdr currently has no built-in statistics refresh setting. */
  intervalMs?: number;
  /** Defaults true, since the current SDK cannot read the OS reduced-motion preference. */
  reducedMotion?: boolean;
}
export interface CpuCounter { total: number; idle: number }
export interface CounterPair { rx: number; tx: number }
export interface Memory {
  total: number; used: number | null; available: number | null; percent: number | null;
  swapTotal: number | null; swapUsed: number | null;
}
export interface Disk {
  device: string; key: string; fs: string; mount: string;
  total: number; used: number; available: number; percent: number;
}
export interface Sample {
  at: number; platform: "Linux" | "Darwin";
  cpu: { percent: number | null; count: number | null; cores: { name: string; percent: number | null }[] };
  memory: Memory | null;
  network: { rx: number | null; tx: number | null; interfaces: { name: string; rx: number | null; tx: number | null }[] } | null;
  disk: { total: number; used: number; available: number; percent: number; scope: "root" | "local"; disks: Disk[] } | null;
  load: number | null; uptime: number | null; os: string | null; kernel: string | null;
  responseMs: number | null; partial: boolean;
  diskError?: boolean; diskStale?: boolean;
  processes: { pid: number; name: string; rss: number; percent: number | null }[];
}
export interface HistoryPoint { at: number; cpu: number | null; memory: number | null; disk: number | null; network: number | null }
export interface RequestToken { id: string; generation: string; machine: string | null; started: number; first: boolean }
export interface SharedStore { get(key: string): unknown; set(key: string, value: unknown): void }
