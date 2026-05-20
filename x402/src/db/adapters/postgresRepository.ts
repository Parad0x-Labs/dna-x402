import { DbClient } from "../connection.js";
import { DurableRecord, DurableRepository, ModularCommerceTable } from "../schema/tables.js";

interface DbDurableRecord<T> {
  id: string;
  version: number;
  payload: T;
  actor_id?: string;
  created_at: string | Date;
  updated_at?: string | Date | null;
}

function toDurable<T>(row: DbDurableRecord<T>): DurableRecord<T> {
  return {
    id: row.id,
    version: row.version,
    payload: row.payload,
    actorId: row.actor_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  };
}

export class PostgresJsonRepository<T> implements DurableRepository<T> {
  constructor(
    private readonly db: DbClient,
    private readonly table: ModularCommerceTable,
  ) {}

  async get(id: string): Promise<DurableRecord<T> | undefined> {
    const result = await this.db.query<DbDurableRecord<T>>(
      `select id, version, payload, actor_id, created_at, updated_at from ${this.table} where id = $1 limit 1`,
      [id],
    );
    return result.rows[0] ? toDurable(result.rows[0]) : undefined;
  }

  async list(): Promise<Array<DurableRecord<T>>> {
    const result = await this.db.query<DbDurableRecord<T>>(
      `select id, version, payload, actor_id, created_at, updated_at from ${this.table} order by created_at asc`,
    );
    return result.rows.map((row) => toDurable(row));
  }

  async put(id: string, payload: T, options: { actorId?: string; immutable?: boolean; now?: Date } = {}): Promise<DurableRecord<T>> {
    if (options.immutable) {
      return this.append(id, payload, options);
    }
    const now = options.now ?? new Date();
    const result = await this.db.query<DbDurableRecord<T>>(
      `insert into ${this.table} (id, version, payload, actor_id, created_at, updated_at)
       values ($1, 1, $2::jsonb, $3, $4, $4)
       on conflict (id) do update
       set version = ${this.table}.version + 1,
           payload = excluded.payload,
           actor_id = coalesce(excluded.actor_id, ${this.table}.actor_id),
           updated_at = excluded.created_at
       returning id, version, payload, actor_id, created_at, updated_at`,
      [id, JSON.stringify(payload), options.actorId, now],
    );
    return toDurable(result.rows[0]);
  }

  async append(id: string, payload: T, options: { actorId?: string; now?: Date } = {}): Promise<DurableRecord<T>> {
    const now = options.now ?? new Date();
    const result = await this.db.query<DbDurableRecord<T>>(
      `insert into ${this.table} (id, version, payload, actor_id, created_at, updated_at)
       values ($1, 1, $2::jsonb, $3, $4, $4)
       returning id, version, payload, actor_id, created_at, updated_at`,
      [id, JSON.stringify(payload), options.actorId, now],
    );
    return toDurable(result.rows[0]);
  }
}
