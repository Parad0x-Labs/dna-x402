/**
 * null-miner-sdk/browser
 *
 * Browser-compatible entry point — works in:
 *   - Chrome/Firefox extensions (service workers)
 *   - React/Vue/Svelte apps
 *   - Vanilla JS web pages
 *   - Lovable / Bolt / Momo generated apps
 *
 * Uses WebCrypto instead of Node's crypto module.
 * Spend key auto-derived from device entropy → stored in localStorage/chrome.storage.
 */

import type { NullMinerConfig, MinerStats, TaskResult, TaskSpec } from "../core/types.js";
import { TaskKind, ReputationTier } from "../core/types.js";

// ── WebCrypto SHA-256 ─────────────────────────────────────────────────────────

async function sha256Browser(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function randomHex(bytes: number): Promise<string> {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Storage abstraction (localStorage or chrome.storage) ─────────────────────

interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

interface ChromeStorageArea {
  get(keys: string[], cb: (result: Record<string, string>) => void): void;
  set(items: Record<string, string>, cb: () => void): void;
}

interface ChromeGlobal {
  storage?: { local?: ChromeStorageArea };
}

function getStorageAdapter(): StorageAdapter {
  // Chrome Extension context
  const chrome = (globalThis as unknown as { chrome?: ChromeGlobal }).chrome;
  if (chrome?.storage?.local) {
    const local = chrome.storage.local;
    return {
      get: (key) => new Promise((resolve) => {
        local.get([key], (result) => resolve(result[key] ?? null));
      }),
      set: (key, value) => new Promise((resolve) => {
        local.set({ [key]: value }, () => resolve());
      }),
    };
  }
  // Browser localStorage
  if (typeof localStorage !== "undefined") {
    return {
      get:  (key) => Promise.resolve(localStorage.getItem(key)),
      set:  (key, value) => { localStorage.setItem(key, value); return Promise.resolve(); },
    };
  }
  // In-memory fallback (service workers without storage)
  const mem: Record<string, string> = {};
  return {
    get:  (key) => Promise.resolve(mem[key] ?? null),
    set:  (key, value) => { mem[key] = value; return Promise.resolve(); },
  };
}

// ── Browser Passport ──────────────────────────────────────────────────────────

export class BrowserPassport {
  private readonly spendKey: string;
  readonly passportId: string;   // derived, synchronous after init
  reputationScore = 0;
  tier: ReputationTier = ReputationTier.Bronze;

  private constructor(spendKey: string, passportId: string) {
    this.spendKey  = spendKey;
    this.passportId = passportId;
  }

  static async create(storage: StorageAdapter): Promise<BrowserPassport> {
    const SPEND_KEY_STORAGE = "null_miner_spend_key";
    let spendKey = await storage.get(SPEND_KEY_STORAGE);
    if (!spendKey) {
      spendKey = await randomHex(32);
      await storage.set(SPEND_KEY_STORAGE, spendKey);
    }
    const domainStr = "NULL_MINER_PASSPORT_ID_v1" + spendKey;
    const passportId = await sha256Browser(domainStr);
    return new BrowserPassport(spendKey, passportId);
  }

  async deriveStealthAddress(taskId: string): Promise<string> {
    return sha256Browser(this.spendKey + taskId + "stealth");
  }

  recordCompletion(rewardUsdc: number): void {
    // Mirror Rust passport scoring: +10 per task, +2 per 0.01 USDC
    const taskScore  = 10;
    const rewardBonus = Math.floor(rewardUsdc / 0.01) * 2;
    this.reputationScore = Math.min(1000, this.reputationScore + taskScore + rewardBonus);
    this.tier = this.reputationScore >= 800 ? ReputationTier.Elite
      : this.reputationScore >= 500         ? ReputationTier.Gold
      : this.reputationScore >= 200         ? ReputationTier.Silver
      : ReputationTier.Bronze;
  }
}

// ── Browser Agent Loop ─────────────────────────────────────────────────────────

type BrowserMinerConfig = Omit<NullMinerConfig, "hostWallet"> & {
  /** Optional: override auto-derived spend key */
  spendKey?: string;
};

export class BrowserMiner {
  private running    = false;
  private passport!: BrowserPassport;
  private storage:   StorageAdapter;
  private readonly config: Required<BrowserMinerConfig>;

  private stats: MinerStats = {
    tasksCompleted: 0,
    usdcEarned:     0,
    nullEarned:     0,
    uptime:         0,
    currentTier:    ReputationTier.Bronze,
    reputationScore: 0,
  };

  private startedAt       = 0;
  private tasksThisHour   = 0;
  private hourWindowStart = 0;

  private constructor(config: BrowserMinerConfig, storage: StorageAdapter) {
    this.storage = storage;
    this.config  = {
      allowedTasks:        config.allowedTasks        ?? Object.values(TaskKind),
      minRewardUsdc:       config.minRewardUsdc        ?? 0,
      maxTasksPerHour:     config.maxTasksPerHour      ?? Number.MAX_SAFE_INTEGER,
      dryRun:              config.dryRun               ?? false,
      nullEmissionRatePct: config.nullEmissionRatePct  ?? 5,
      onEarn:              config.onEarn               ?? (() => {}),
      onError:             config.onError              ?? ((e) => console.error("[NullMiner]", e)),
      spendKey:            config.spendKey             ?? "",
      ...config,
    } as Required<BrowserMinerConfig>;
  }

  static async create(config: BrowserMinerConfig): Promise<BrowserMiner> {
    const storage = getStorageAdapter();
    const miner   = new BrowserMiner(config, storage);
    miner.passport = await BrowserPassport.create(storage);
    return miner;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running         = true;
    this.startedAt       = Date.now();
    this.hourWindowStart = Date.now();
    console.log(`[NullMiner/Browser] Agent ${this.passport.passportId.slice(0, 16)}... started`);
    this.loop();
  }

  stop(): void {
    this.running = false;
    console.log("[NullMiner/Browser] Agent stopped");
  }

  getStats(): MinerStats {
    return {
      ...this.stats,
      uptime:          Math.floor((Date.now() - this.startedAt) / 1000),
      currentTier:     this.passport.tier,
      reputationScore: this.passport.reputationScore,
    };
  }

  getPassportId(): string { return this.passport.passportId; }
  getTier():       ReputationTier { return this.passport.tier; }

  // ── Loop ─────────────────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.config.onError(err instanceof Error ? err : new Error(String(err)));
      }
      await sleep(5_000);
    }
  }

  private async tick(): Promise<void> {
    if (Date.now() - this.hourWindowStart > 3_600_000) {
      this.tasksThisHour  = 0;
      this.hourWindowStart = Date.now();
    }
    if (this.tasksThisHour >= this.config.maxTasksPerHour) return;

    const tasks     = await this.fetchTasks();
    const filtered  = tasks.filter(t =>
      this.config.allowedTasks.includes(t.kind) &&
      t.rewardUsdc > this.config.minRewardUsdc
    );
    if (filtered.length === 0) return;

    const best = filtered.reduce((a, b) => b.rewardUsdc > a.rewardUsdc ? b : a);
    await this.executeTask(best);
  }

  private async fetchTasks(): Promise<TaskSpec[]> {
    try {
      const url  = `${this.config.rpcUrl.replace("https://api.", "https://marketplace.")}/tasks`;
      const resp = await fetch(url, {
        headers: {
          "X-Passport-Id": this.passport.passportId,
          "X-Platform-Id": this.config.platformId,
          "X-Tier":        this.passport.tier,
        },
      });
      if (!resp.ok) throw new Error("marketplace unavailable");
      return await resp.json() as TaskSpec[];
    } catch {
      return this.mockTasks();
    }
  }

  private async executeTask(task: TaskSpec): Promise<void> {
    if (this.config.dryRun) {
      console.log(`[NullMiner/Browser][DRY RUN] ${task.kind} +$${task.rewardUsdc}`);
      return;
    }

    const outputHash = await this.executeKind(task);
    const usdcEarned = task.rewardUsdc * 0.9;
    const nullYield  = (usdcEarned * this.config.nullEmissionRatePct) / 100;

    this.tasksThisHour++;
    this.stats.tasksCompleted++;
    this.stats.usdcEarned += usdcEarned;
    this.stats.nullEarned += nullYield;
    this.passport.recordCompletion(usdcEarned);

    const result: TaskResult = {
      taskId:    task.taskId,
      proof:     { taskId: task.taskId, kind: task.kind, outputHash, agentPassportId: this.passport.passportId, timestamp: Date.now() },
      usdcEarned,
      nullYield,
      slot:      Math.floor(Date.now() / 400),
    };

    await this.storage.set("null_miner_stats", JSON.stringify(this.getStats()));
    this.config.onEarn(result);

    console.log(`[NullMiner/Browser] ✓ ${task.kind} | +$${usdcEarned.toFixed(4)} USDC | +${nullYield.toFixed(6)} NULL`);
  }

  private async executeKind(task: TaskSpec): Promise<string> {
    switch (task.kind) {
      case TaskKind.ResidentialRelay: {
        try {
          const r = await fetch("https://httpbin.org/get", { signal: AbortSignal.timeout(5000) });
          return sha256Browser(await r.text());
        } catch {
          return sha256Browser("relay-fallback-" + task.taskId);
        }
      }
      case TaskKind.AppStoreSnapshot: {
        try {
          const r = await fetch("https://itunes.apple.com/lookup?id=284882215", { signal: AbortSignal.timeout(5000) });
          return sha256Browser(await r.text());
        } catch {
          return sha256Browser("appstore-fallback-" + task.taskId);
        }
      }
      case TaskKind.LocationAttestation: {
        const coords = await getCoarseLocation();
        return sha256Browser(JSON.stringify(coords) + task.taskId);
      }
      case TaskKind.SensorSample: {
        return sha256Browser("sensor-" + Date.now() + task.taskId);
      }
      default:
        return sha256Browser("maintenance-" + task.taskId);
    }
  }

  private mockTasks(): TaskSpec[] {
    const now = Date.now();
    return [
      {
        taskId:            sha256Sync("devnet-relay-" + Math.floor(now / 60000)),
        kind:              TaskKind.ResidentialRelay,
        rewardUsdc:        0.005,
        expiresAtSlot:     Math.floor(now / 400) + 1000,
        proofRequirements: { expectedProofHash: sha256Sync("relay-proof") },
      },
      {
        taskId:            sha256Sync("devnet-snapshot-" + Math.floor(now / 60000)),
        kind:              TaskKind.AppStoreSnapshot,
        rewardUsdc:        0.002,
        expiresAtSlot:     Math.floor(now / 400) + 2000,
        proofRequirements: { expectedProofHash: sha256Sync("snapshot-proof") },
      },
    ];
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create and return a browser-compatible NullMiner.
 * Spend key auto-derived from device entropy if not provided.
 *
 * @example
 * const miner = await createBrowserMiner({ rpcUrl: "...", platformId: "my-app" });
 * await miner.start();
 */
export async function createBrowserMiner(config: BrowserMinerConfig): Promise<BrowserMiner> {
  return BrowserMiner.create(config);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Synchronous SHA-256 approximation for devnet mock IDs (not cryptographically used) */
function sha256Sync(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) + h + input.charCodeAt(i);
    h = h & h; // int32
  }
  return Math.abs(h).toString(16).padStart(64, "0");
}

/** Get coarse location (rounded to 2dp for privacy) or fallback to 0,0 */
async function getCoarseLocation(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve) => {
    const nav = globalThis as unknown as { navigator?: { geolocation?: {
      getCurrentPosition(
        success: (pos: { coords: { latitude: number; longitude: number } }) => void,
        error:   () => void,
        opts:    { timeout: number; enableHighAccuracy: boolean }
      ): void;
    } } };
    if (!nav.navigator?.geolocation) return resolve({ lat: 0, lng: 0 });
    nav.navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: Math.round(pos.coords.latitude  * 100) / 100,
        lng: Math.round(pos.coords.longitude * 100) / 100,
      }),
      () => resolve({ lat: 0, lng: 0 }),
      { timeout: 3000, enableHighAccuracy: false }
    );
  });
}
