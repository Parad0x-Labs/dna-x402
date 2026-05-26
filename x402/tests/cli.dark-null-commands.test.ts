import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const cleanupPaths: string[] = [];
afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop();
    if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});
function makeTempDir(prefix: string): string {
  const tmpRoot = path.resolve(process.cwd(), "..", "reports", "test-tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tmpRoot, prefix));
  cleanupPaths.push(dir);
  return dir;
}

describe("Dark Null CLI scaffolding correctness", () => {
  it("init seller scaffold — index.ts does NOT contain mainnet_ready: true", async () => {
    const targetDir = makeTempDir("dark-null-seller-mainnet-");
    const exitCode = await runCli(["init", "seller", targetDir, "--no-install"]);
    expect(exitCode).toBe(0);
    const index = readFileSync(path.join(targetDir, "index.ts"), "utf8");
    expect(index).not.toContain("mainnet_ready: true");
    expect(index).not.toContain("mainnet_ready:true");
  }, 30_000);

  it("init seller scaffold — index.ts does NOT contain hardcoded API key pattern (sk_xxx...)", async () => {
    const targetDir = makeTempDir("dark-null-seller-apikey-");
    const exitCode = await runCli(["init", "seller", targetDir, "--no-install"]);
    expect(exitCode).toBe(0);
    const index = readFileSync(path.join(targetDir, "index.ts"), "utf8");
    // Must not contain an API key pattern: sk_ followed by 32+ lowercase alphanum chars
    expect(index).not.toMatch(/sk_[a-z0-9]{32}/);
  }, 30_000);

  it("init buyer scaffold — index.ts does NOT contain hardcoded SOL private key byte arrays", async () => {
    const targetDir = makeTempDir("dark-null-buyer-privkey-");
    const exitCode = await runCli(["init", "buyer", targetDir, "--no-install"]);
    expect(exitCode).toBe(0);
    const index = readFileSync(path.join(targetDir, "index.ts"), "utf8");
    // Private key byte arrays would be 64-element numeric arrays like [1,2,3,...,64 values]
    // We check that no such dense numeric array appears in the scaffolded file
    expect(index).not.toMatch(/\[\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+/);
  }, 30_000);

  it("init agent --template marketplace — manifest.json contains recipeId-style shopId field", async () => {
    const targetDir = makeTempDir("dark-null-marketplace-manifest-");
    const exitCode = await runCli(["init", "agent", targetDir, "--template", "marketplace", "--no-install"]);
    expect(exitCode).toBe(0);
    const manifestRaw = readFileSync(path.join(targetDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    // The manifest must have a shopId field as its primary identifier
    expect(typeof manifest["shopId"]).toBe("string");
    expect((manifest["shopId"] as string).length).toBeGreaterThan(0);
    // Also verify manifestVersion is present for proper manifest structure
    expect(typeof manifest["manifestVersion"]).toBe("string");
  }, 30_000);

  it("init agent --template trading — index.ts contains dna-x402/seller import for paid endpoints", async () => {
    const targetDir = makeTempDir("dark-null-trading-import-");
    const exitCode = await runCli(["init", "agent", targetDir, "--template", "trading", "--no-install"]);
    expect(exitCode).toBe(0);
    const index = readFileSync(path.join(targetDir, "index.ts"), "utf8");
    // Trading template is a seller agent using dnaPrice and dnaSeller
    expect(index).toContain("dna-x402/seller");
  }, 30_000);

  it("init agent --template service — package.json contains dna-x402 as a dependency", async () => {
    const targetDir = makeTempDir("dark-null-service-pkgjson-");
    const exitCode = await runCli(["init", "agent", targetDir, "--template", "service", "--no-install"]);
    expect(exitCode).toBe(0);
    const pkgRaw = readFileSync(path.join(targetDir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies).toBeDefined();
    expect(typeof pkg.dependencies!["dna-x402"]).toBe("string");
  }, 30_000);
});
