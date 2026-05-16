import { FileSnapshotRepository } from "./adapters/fileRepository.js";
import { PostgresJsonRepository } from "./adapters/postgresRepository.js";
import { DbClient } from "./connection.js";
import { DurableRepository, MODULAR_COMMERCE_TABLES, ModularCommerceTable } from "./schema/tables.js";

export type CommerceRepositories = {
  [K in ModularCommerceTable]: DurableRepository<unknown>;
};

export function createFileCommerceRepositories(snapshotPath: string): CommerceRepositories {
  return Object.fromEntries(
    MODULAR_COMMERCE_TABLES.map((table) => [table, new FileSnapshotRepository(snapshotPath, table)]),
  ) as unknown as CommerceRepositories;
}

export function createPostgresCommerceRepositories(db: DbClient): CommerceRepositories {
  return Object.fromEntries(
    MODULAR_COMMERCE_TABLES.map((table) => [table, new PostgresJsonRepository(db, table)]),
  ) as unknown as CommerceRepositories;
}
