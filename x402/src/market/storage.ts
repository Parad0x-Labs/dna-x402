import fs from "node:fs";
import path from "node:path";
import { MarketEvent } from "./types.js";

export interface MarketStorageOptions {
  snapshotPath?: string;
}

export class MarketStorage {
  private readonly events: MarketEvent[] = [];
  private readonly snapshotPath?: string;

  constructor(options: MarketStorageOptions = {}) {
    this.snapshotPath = options.snapshotPath;
    this.loadSnapshot();
  }

  append(event: MarketEvent): void {
    this.events.push(event);
    this.persistSnapshot();
  }

  all(): MarketEvent[] {
    return [...this.events];
  }

  inWindow(windowMs: number, now = new Date()): MarketEvent[] {
    const minTs = now.getTime() - windowMs;
    return this.events.filter((event) => new Date(event.ts).getTime() >= minTs);
  }

  between(startMs: number, endMs: number): MarketEvent[] {
    return this.events.filter((event) => {
      const ts = new Date(event.ts).getTime();
      return ts >= startMs && ts <= endMs;
    });
  }

  private loadSnapshot(): void {
    if (!this.snapshotPath) {
      return;
    }
    if (!fs.existsSync(this.snapshotPath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.snapshotPath, "utf8");
      const parsed = JSON.parse(raw) as MarketEvent[];
      if (Array.isArray(parsed)) {
        this.events.splice(0, this.events.length, ...parsed);
      }
    } catch {
      // Ignore snapshot load errors in dev mode.
    }
  }

  private persistSnapshot(): void {
    if (!this.snapshotPath) {
      return;
    }
    const dir = path.dirname(this.snapshotPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.snapshotPath, JSON.stringify(this.events, null, 2));
  }
}
