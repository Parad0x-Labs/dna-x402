import crypto from "node:crypto";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export interface Repository<T, Id extends string = string> {
  get(id: Id): T | undefined;
  list(): T[];
  put(id: Id, value: T): T;
}

export class InMemoryRepository<T, Id extends string = string> implements Repository<T, Id> {
  private readonly rows = new Map<Id, T>();

  get(id: Id): T | undefined {
    return this.rows.get(id);
  }

  list(): T[] {
    return Array.from(this.rows.values());
  }

  put(id: Id, value: T): T {
    this.rows.set(id, value);
    return value;
  }
}

export function nowIso(now: () => Date = () => new Date()): string {
  return now().toISOString();
}
