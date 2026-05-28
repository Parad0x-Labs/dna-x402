/**
 * NULL Miner SDK — Task Registry
 *
 * Extensible registry of task executors. Platforms register their own task
 * types here. The agent loop queries this registry to find executors.
 *
 * Built-in executors:
 *   - ResidentialRelay      (bandwidth proxy)
 *   - AppStoreSnapshot      (iOS/Android data)
 *   - LocationAttestation   (GPS proof-of-location)
 *   - ProtocolMaintenance   (chaff/nullifier cleanup)
 *
 * Custom executor example:
 *   registry.register(TaskKind.ResidentialRelay, new MyRelayExecutor());
 */

import { createHash } from "crypto";
import { TaskKind } from "../core/types.js";
import type { TaskSpec } from "../core/types.js";

// ── Executor Interface ────────────────────────────────────────────────────────

export interface TaskExecutor {
  /**
   * Execute the task and return the SHA-256 hash of the output.
   * The hash is used as the proof submitted to the escrow.
   */
  execute(task: TaskSpec): Promise<string>;
}

// ── Built-in Executors ────────────────────────────────────────────────────────

/**
 * ResidentialRelay — proxies HTTP requests via the host's residential IP.
 * In browser extension context: uses fetch() directly (residential IP by default).
 * Proof: SHA-256(response_status + response_body_hash + latency_ms).
 */
export class ResidentialRelayExecutor implements TaskExecutor {
  async execute(task: TaskSpec): Promise<string> {
    const startMs = Date.now();

    // Decrypt payload to get URL (in full impl: decrypt with agent private key)
    // Devnet: use a safe public endpoint
    const targetUrl = "https://httpbin.org/get";

    try {
      const resp = await fetch(targetUrl, {
        method:  "GET",
        headers: { "User-Agent": "NullMiner/0.1.0" },
        signal:  AbortSignal.timeout(10_000),
      });

      const bodyText   = await resp.text();
      const latencyMs  = Date.now() - startMs;
      const bodyHash   = sha256(bodyText);
      const proofInput = `${resp.status}:${bodyHash}:${latencyMs}`;
      const outputHash = sha256(proofInput);

      console.log(`  [Relay] ${resp.status} in ${latencyMs}ms → proof ${outputHash.slice(0, 16)}...`);
      return outputHash;
    } catch (err) {
      throw new Error(`RelayExecutor failed: ${err}`);
    }
  }
}

/**
 * AppStoreSnapshot — queries App Store / Google Play data.
 * Proof: SHA-256(app_id + price + timestamp).
 */
export class AppStoreSnapshotExecutor implements TaskExecutor {
  async execute(task: TaskSpec): Promise<string> {
    // Devnet: query a known free app
    const appId    = "284882215"; // Facebook app ID (always exists)
    const country  = "us";
    const url      = `https://itunes.apple.com/lookup?id=${appId}&country=${country}`;

    try {
      const resp    = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      const data    = await resp.json() as { results?: Array<{ price?: number }> };
      const price   = data.results?.[0]?.price ?? 0;
      const ts      = Math.floor(Date.now() / 60_000) * 60_000; // minute-granularity
      const output  = sha256(`${appId}:${country}:${price}:${ts}`);

      console.log(`  [AppStore] app=${appId} price=$${price} → proof ${output.slice(0, 16)}...`);
      return output;
    } catch (err) {
      throw new Error(`AppStoreExecutor failed: ${err}`);
    }
  }
}

/**
 * LocationAttestation — generates a ZK proof-of-location.
 * In browser context: uses Geolocation API.
 * Proof: SHA-256(lat_rounded + lon_rounded + accuracy + timestamp).
 * Note: exact coordinates are NOT included — only proof of being within a radius.
 */
export class LocationAttestationExecutor implements TaskExecutor {
  async execute(task: TaskSpec): Promise<string> {
    // In real browser context: navigator.geolocation.getCurrentPosition(...)
    // Devnet: use mock coordinates
    const lat       = 51.5074;   // London (mock)
    const lon       = -0.1278;
    const accuracy  = 15;        // meters
    const ts        = Math.floor(Date.now() / 300_000) * 300_000; // 5-min granularity

    // Round to 2 decimal places (~1.1km precision) — no exact location in proof
    const latRounded = Math.round(lat * 100) / 100;
    const lonRounded = Math.round(lon * 100) / 100;

    const output = sha256(`${latRounded}:${lonRounded}:${accuracy}:${ts}`);
    console.log(`  [Location] ~${latRounded},${lonRounded} acc=${accuracy}m → proof ${output.slice(0, 16)}...`);
    return output;
  }
}

/**
 * ProtocolMaintenance — runs internal protocol cleanup tasks.
 * Maps to useful-chaff-market::ChaffJobKind variants.
 * Proof: SHA-256(task_id + completed_at).
 */
export class ProtocolMaintenanceExecutor implements TaskExecutor {
  async execute(task: TaskSpec): Promise<string> {
    const completedAt = Date.now();
    const output      = sha256(`${task.taskId}:${completedAt}`);
    console.log(`  [Maintenance] task=${task.taskId.slice(0, 16)}... → proof ${output.slice(0, 16)}...`);
    return output;
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

export class TaskRegistry {
  private readonly executors = new Map<TaskKind, TaskExecutor>();

  constructor() {
    // Register all built-in executors
    this.register(TaskKind.ResidentialRelay,    new ResidentialRelayExecutor());
    this.register(TaskKind.AppStoreSnapshot,    new AppStoreSnapshotExecutor());
    this.register(TaskKind.LocationAttestation, new LocationAttestationExecutor());
    this.register(TaskKind.ProtocolMaintenance, new ProtocolMaintenanceExecutor());
  }

  register(kind: TaskKind, executor: TaskExecutor): void {
    this.executors.set(kind, executor);
  }

  get(kind: TaskKind): TaskExecutor | undefined {
    return this.executors.get(kind);
  }

  listSupported(): TaskKind[] {
    return Array.from(this.executors.keys());
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
