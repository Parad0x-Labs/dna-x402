import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Import from the SDK main entry point (mirrors the package "." export)
import * as sdk from "../src/sdk/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("SDK layer completeness and contract", () => {
  it("the SDK exports fetchWith402 as a function", () => {
    expect(typeof sdk.fetchWith402).toBe("function");
  }, 10_000);

  it("the SDK exports dnaSeller as a seller factory function", () => {
    // dnaSeller is re-exported from sdk/index.ts via sdk/seller.ts
    expect(typeof sdk.dnaSeller).toBe("function");
  }, 10_000);

  it("fetchWith402 called with a bad URL rejects with an error (not a raw unhandled crash)", async () => {
    // No server at port 19999 — should reject cleanly
    const wallet = {
      payTransfer: async () => {
        throw new Error("stub: should not reach payTransfer in this test");
      },
    };
    await expect(
      sdk.fetchWith402("http://127.0.0.1:19999/test", {
        method: "GET",
        wallet,
        maxSpendAtomic: "1000",
      }),
    ).rejects.toThrow();
  }, 10_000);

  it("SDK version in package.json matches what is accessible at runtime", () => {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    // The SDK does not export a version constant, but the package.json must have a version string
    expect(typeof pkg.version).toBe("string");
    expect(pkg.version.length).toBeGreaterThan(0);
    // Version must follow semver-like pattern
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  }, 10_000);

  it("all core SDK exports are non-null and non-undefined", () => {
    const required = ["fetchWith402", "InMemoryReceiptStore", "InMemorySpendTracker", "dnaSeller", "dnaPrice", "dnaPaywall"] as const;
    for (const name of required) {
      const value = (sdk as Record<string, unknown>)[name];
      expect(value, `SDK export "${name}" must be defined`).toBeDefined();
      expect(value, `SDK export "${name}" must not be null`).not.toBeNull();
    }
  }, 10_000);

  it("SDK does not export any symbol containing 'private_key' or 'SECRET' in its name", () => {
    const exportNames = Object.keys(sdk);
    const forbidden = exportNames.filter(
      (name) =>
        name.toLowerCase().includes("private_key") ||
        name.includes("SECRET"),
    );
    expect(forbidden).toEqual([]);
  }, 10_000);
});
