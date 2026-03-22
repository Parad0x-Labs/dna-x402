import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../src/logging/audit.js";
import { logInfo, shouldEmitStdoutLogs } from "../src/logging/logger.js";

describe("stdout logging runtime defaults", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables stdout logs in test runtimes unless explicitly overridden", () => {
    expect(shouldEmitStdoutLogs({ VITEST: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldEmitStdoutLogs({ VITEST_POOL_ID: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldEmitStdoutLogs({ VITEST_WORKER_ID: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldEmitStdoutLogs({ TEST: "true" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldEmitStdoutLogs({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldEmitStdoutLogs({} as NodeJS.ProcessEnv, ["node", "/tmp/vitest.mjs"])).toBe(false);
    expect(shouldEmitStdoutLogs({ VITEST: "1", X402_LOG_STDOUT: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("keeps stdout logs enabled by default in non-test runtimes", () => {
    expect(shouldEmitStdoutLogs({} as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldEmitStdoutLogs({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("suppresses helper logging when stdout logging is disabled", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.stubEnv("VITEST", "1");
    logInfo("suppressed");

    expect(consoleSpy).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("lets AuditLogger inherit the same quiet-by-default test behavior", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.stubEnv("VITEST", "1");
    const auditLog = new AuditLogger();
    auditLog.record({ kind: "CONFIG_LOADED", meta: { source: "test" } });

    expect(consoleSpy).not.toHaveBeenCalled();
    auditLog.close();
    vi.unstubAllEnvs();
  });
});
