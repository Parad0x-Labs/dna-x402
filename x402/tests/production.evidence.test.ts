import { describe, expect, it } from "vitest";
import { buildProductionEvidenceReport, redactValue } from "../src/deploy/productionEvidence.js";

describe("production evidence collector", () => {
  it("fails closed when production deployment facts are missing", () => {
    const report = buildProductionEvidenceReport({}, "2026-05-15T00:00:00.000Z");

    expect(report.status).toBe("BLOCKED");
    expect(report.blockers).toEqual(expect.arrayContaining([
      "NODE_ENV=production is required for production evidence.",
      "Postgres driver and repository mode are required.",
      "X402_DATABASE_URL is required for production Postgres evidence.",
      "HELIUS_RPC or HELIUS_API_KEY is required for production Solana RPC evidence.",
    ]));
    expect(report.fields.some((field) => field.status === "MISSING")).toBe(true);
  });

  it("blocks dangerous production flags even when deployment facts are present", () => {
    const report = buildProductionEvidenceReport({
      NODE_ENV: "production",
      X402_DB_DRIVER: "postgres",
      X402_REPOSITORY_MODE: "postgres",
      X402_DATABASE_URL: "postgres://user:pass@db.example.com:5432/x402",
      HELIUS_RPC: "https://mainnet.helius-rpc.com/?api-key=secret-key",
      X402_PRODUCTION_API_URL: "https://api.example.com",
      X402_PRODUCTION_FRONTEND_URL: "https://docs.example.com",
      X402_PRODUCTION_SERVER_PROVIDER: "provider",
      X402_PRODUCTION_SERVER_REGION: "eu-west",
      X402_PRODUCTION_POSTGRES_PROVIDER: "provider-db",
      X402_PRODUCTION_POSTGRES_REGION: "eu-west",
      X402_PRODUCTION_BACKUP_METHOD: "managed snapshots + pg_dump",
      X402_PRODUCTION_BACKUP_SCHEDULE: "daily",
      X402_PRODUCTION_PITR_STATUS: "enabled",
      X402_PRODUCTION_MONITORING_URL: "https://monitoring.example.com",
      X402_PRODUCTION_EMERGENCY_PAUSE_ROUTE: "https://api.example.com/admin/x402/emergency",
      X402_PRODUCTION_ROLLBACK_PLAN: "redeploy previous release and keep receipts readable",
      X402_RELEASE_VERSION: "2026.05.15",
      X402_RELEASE_APPROVER: "Saulius",
      X402_LAUNCH_SCOPE: "Public Low-Risk Builder/API Pilot",
      X402_ENABLE_BACKEND_KEY_CUSTODY: "1",
    }, "2026-05-15T00:00:00.000Z");

    expect(report.status).toBe("BLOCKED");
    expect(report.blockers).toContain("X402_ENABLE_BACKEND_KEY_CUSTODY must remain disabled unless separately gate-approved.");
  });

  it("passes only with production facts present and dangerous gates disabled", () => {
    const report = buildProductionEvidenceReport({
      NODE_ENV: "production",
      X402_DB_DRIVER: "postgres",
      X402_REPOSITORY_MODE: "postgres",
      X402_DATABASE_URL: "postgres://user:pass@db.example.com:5432/x402",
      HELIUS_RPC: "https://mainnet.helius-rpc.com/?api-key=secret-key",
      X402_PRODUCTION_API_URL: "https://api.example.com",
      X402_PRODUCTION_FRONTEND_URL: "https://docs.example.com",
      X402_PRODUCTION_SERVER_PROVIDER: "provider",
      X402_PRODUCTION_SERVER_REGION: "eu-west",
      X402_PRODUCTION_POSTGRES_PROVIDER: "provider-db",
      X402_PRODUCTION_POSTGRES_REGION: "eu-west",
      X402_PRODUCTION_BACKUP_METHOD: "managed snapshots + pg_dump",
      X402_PRODUCTION_BACKUP_SCHEDULE: "daily",
      X402_PRODUCTION_PITR_STATUS: "enabled",
      X402_PRODUCTION_MONITORING_URL: "https://monitoring.example.com",
      X402_PRODUCTION_EMERGENCY_PAUSE_ROUTE: "https://api.example.com/admin/x402/emergency",
      X402_PRODUCTION_ROLLBACK_PLAN: "redeploy previous release and keep receipts readable",
      X402_RELEASE_VERSION: "2026.05.15",
      X402_RELEASE_APPROVER: "Saulius",
      X402_LAUNCH_SCOPE: "Public Low-Risk Builder/API Pilot",
      X402_ENABLE_DIRECT_SPLIT_FEES: "0",
      X402_ENABLE_UNATTENDED_SIGNING: "0",
      X402_ENABLE_BACKEND_KEY_CUSTODY: "0",
      X402_ENABLE_PUBLIC_NETTING: "0",
      X402_ENABLE_PHYSICAL_GOODS: "0",
      X402_ENABLE_HIGH_RISK_CATEGORIES: "0",
      X402_ENABLE_POLYMARKET_LIVE: "0",
      X402_PLATFORM_FEE_MODE: "display_only",
    }, "2026-05-15T00:00:00.000Z");

    expect(report.status).toBe("PASS");
    expect(report.blockers).toEqual([]);
  });

  it("redacts production secrets and token-like URL query params", () => {
    expect(redactValue("X402_DATABASE_URL", "postgres://user:password@db.example.com:5432/x402"))
      .toContain("REDACTED");
    expect(redactValue("HELIUS_RPC", "https://mainnet.helius-rpc.com/?api-key=secret-key"))
      .toContain("REDACTED");
    expect(redactValue("X402_PRODUCTION_API_URL", "https://api.example.com/probe?token=secret"))
      .toBe("https://api.example.com/probe?token=REDACTED");
  });
});
