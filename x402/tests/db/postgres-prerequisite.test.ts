import { describe, expect, it } from "vitest";
import { databaseUrlFromEnv } from "../../src/db/connection.js";
import { postgresAvailable } from "./postgres-test-helpers.js";

describe("live Postgres test prerequisite", () => {
  it.skipIf(postgresAvailable)("reports live Postgres suites skipped because X402_DATABASE_URL is not configured", () => {
    expect(databaseUrlFromEnv()).toBeUndefined();
  });

  it.skipIf(!postgresAvailable)("uses configured X402_DATABASE_URL with no file-adapter fallback", () => {
    expect(databaseUrlFromEnv()).toMatch(/^postgres(?:ql)?:\/\//);
  });
});
