import fs from "node:fs";
import path from "node:path";
import { DurableRecord, DurableRepository, ModularCommerceTable } from "../schema/tables.js";

type Snapshot = Record<string, Array<DurableRecord<unknown>>>;

export class FileSnapshotRepository<T> implements DurableRepository<T> {
  constructor(
    private readonly snapshotPath: string,
    private readonly table: ModularCommerceTable,
  ) {}

  async get(id: string): Promise<DurableRecord<T> | undefined> {
    return this.rows().find((row) => row.id === id) as DurableRecord<T> | undefined;
  }

  async list(): Promise<Array<DurableRecord<T>>> {
    return this.rows() as Array<DurableRecord<T>>;
  }

  async put(id: string, payload: T, options: { actorId?: string; immutable?: boolean; now?: Date } = {}): Promise<DurableRecord<T>> {
    const nowIso = (options.now ?? new Date()).toISOString();
    const snapshot = this.load();
    const rows = snapshot[this.table] ?? [];
    const index = rows.findIndex((row) => row.id === id);
    if (index >= 0 && options.immutable) {
      throw new Error(`immutable record already exists in ${this.table}: ${id}`);
    }
    const existing = rows[index];
    const row: DurableRecord<T> = {
      id,
      version: existing ? existing.version + 1 : 1,
      payload,
      actorId: options.actorId ?? existing?.actorId,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: existing ? nowIso : undefined,
    };
    if (index >= 0) {
      rows[index] = row as DurableRecord<unknown>;
    } else {
      rows.push(row as DurableRecord<unknown>);
    }
    snapshot[this.table] = rows;
    this.save(snapshot);
    return row;
  }

  async append(id: string, payload: T, options: { actorId?: string; now?: Date } = {}): Promise<DurableRecord<T>> {
    return this.put(id, payload, { ...options, immutable: true });
  }

  private rows(): Array<DurableRecord<unknown>> {
    return this.load()[this.table] ?? [];
  }

  private load(): Snapshot {
    if (!fs.existsSync(this.snapshotPath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(this.snapshotPath, "utf8")) as Snapshot;
  }

  private save(snapshot: Snapshot): void {
    fs.mkdirSync(path.dirname(this.snapshotPath), { recursive: true });
    fs.writeFileSync(this.snapshotPath, JSON.stringify(snapshot, null, 2));
  }
}
