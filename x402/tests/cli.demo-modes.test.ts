import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

describe("cli demo modes — validation and help paths", () => {
  it("top-level --help output contains demo, init, and agent-builder", async () => {
    const lines: string[] = [];
    const exitCode = await runCli([], { stdout: (msg) => lines.push(msg), stderr: () => {} });
    expect(exitCode).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("demo");
    expect(output).toContain("init");
    expect(output).toContain("agent-builder");
  }, 30_000);

  it("top-level help output contains dna-x402", async () => {
    const lines: string[] = [];
    await runCli(["--help"], { stdout: (msg) => lines.push(msg), stderr: () => {} });
    const output = lines.join("\n");
    expect(output).toContain("dna-x402");
  }, 30_000);

  it("top-level help output contains seller and buyer subcommand references", async () => {
    const lines: string[] = [];
    await runCli(["-h"], { stdout: (msg) => lines.push(msg), stderr: () => {} });
    const output = lines.join("\n");
    expect(output).toContain("seller");
    expect(output).toContain("buyer");
  }, 30_000);

  it("demo buyer --base-url with not-a-url rejects with descriptive error", async () => {
    await expect(
      runCli(["demo", "buyer", "--base-url", "not-a-url"]),
    ).rejects.toThrow("Invalid --base-url");
  }, 30_000);

  it("demo seller --mode INVALID_MODE rejects with descriptive error", async () => {
    await expect(
      runCli(["demo", "seller", "--mode", "INVALID_MODE"]),
    ).rejects.toThrow("Invalid --mode");
  }, 30_000);

  it("demo seller --port abc rejects with port error message", async () => {
    await expect(
      runCli(["demo", "seller", "--port", "abc"]),
    ).rejects.toThrow("Invalid --port");
  }, 30_000);
});
