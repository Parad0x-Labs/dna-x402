import { afterEach, describe, expect, it } from "vitest";
import {
  assertPhase0BrowserEnvReady,
  getPhase0EnvReadiness,
  optionalEnv,
  requireEnv,
} from "../labs/polymarket-phase0/phase0-env.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(() => {
  resetEnv();
});

describe("polymarket phase0 env aliases and diagnostics", () => {
  it("resolves builder aliases through requireEnv and optionalEnv", () => {
    process.env.POLY_BUILDER_CODE = "builder-code";
    process.env.POLYMARKET_API_KEY = "api-key";
    process.env.POLYMARKET_API_SECRET = "api-secret";
    process.env.POLYMARKET_API_PASSPHRASE = "api-passphrase";

    expect(requireEnv("POLYMARKET_BUILDER_CODE")).toBe("builder-code");
    expect(requireEnv("POLYMARKET_BUILDER_API_KEY")).toBe("api-key");
    expect(requireEnv("POLYMARKET_BUILDER_SECRET")).toBe("api-secret");
    expect(optionalEnv("POLYMARKET_BUILDER_PASSPHRASE")).toBe("api-passphrase");
  });

  it("reports all missing browser harness variables in one error", () => {
    expect(() => assertPhase0BrowserEnvReady()).toThrow(
      /Missing required Phase 0 browser environment variables:/,
    );
    expect(() => assertPhase0BrowserEnvReady()).toThrow(/POLYMARKET_RELAYER_URL/);
    expect(() => assertPhase0BrowserEnvReady()).toThrow(/POLYMARKET_BUILDER_API_KEY/);
  });

  it("marks browser harness ready while flagging missing live order extras", () => {
    process.env.POLYMARKET_RELAYER_URL = "https://relayer.example";
    process.env.POLYMARKET_CLOB_API_URL = "https://clob.example";
    process.env.POLYMARKET_RPC_URL = "https://polygon-rpc.example";
    process.env.POLYMARKET_OWNER_SIGNER_SOURCE = "browser-local";
    process.env.POLY_BUILDER_CODE = "builder-code";
    process.env.POLYMARKET_API_KEY = "api-key";
    process.env.POLYMARKET_API_SECRET = "api-secret";
    process.env.POLYMARKET_API_PASSPHRASE = "api-passphrase";

    expect(() => assertPhase0BrowserEnvReady()).not.toThrow();

    const readiness = getPhase0EnvReadiness();
    expect(readiness.browserHarness.every((entry) => entry.present)).toBe(true);
    expect(readiness.browserHarness.find((entry) => entry.canonicalName === "POLYMARKET_BUILDER_API_KEY"))
      .toMatchObject({ sourceName: "POLYMARKET_API_KEY" });
    expect(readiness.liveOrderFlowExtras.filter((entry) => !entry.present).map((entry) => entry.canonicalName))
      .toEqual(["POLYMARKET_PRIVATE_KEY", "DEPOSIT_WALLET_ADDRESS"]);
  });
});
