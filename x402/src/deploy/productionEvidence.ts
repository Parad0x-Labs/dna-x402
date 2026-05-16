export type ProductionEvidenceStatus = "PASS" | "BLOCKED";

export type ProductionEvidenceField = {
  name: string;
  env: string;
  value: string;
  status: "PRESENT" | "MISSING";
};

export type ProductionEvidenceCheck = {
  name: string;
  status: "PASS" | "BLOCKED" | "WARN";
  detail: string;
};

export type ProductionEvidenceReport = {
  version: "production_evidence_v1";
  generatedAt: string;
  status: ProductionEvidenceStatus;
  fields: ProductionEvidenceField[];
  checks: ProductionEvidenceCheck[];
  blockers: string[];
};

const REQUIRED_FIELDS: Array<{ name: string; env: string }> = [
  { name: "Production API URL", env: "X402_PRODUCTION_API_URL" },
  { name: "Production frontend/docs URL", env: "X402_PRODUCTION_FRONTEND_URL" },
  { name: "Production server provider", env: "X402_PRODUCTION_SERVER_PROVIDER" },
  { name: "Production server region", env: "X402_PRODUCTION_SERVER_REGION" },
  { name: "Production Postgres provider", env: "X402_PRODUCTION_POSTGRES_PROVIDER" },
  { name: "Production Postgres region", env: "X402_PRODUCTION_POSTGRES_REGION" },
  { name: "Backup method", env: "X402_PRODUCTION_BACKUP_METHOD" },
  { name: "Backup schedule", env: "X402_PRODUCTION_BACKUP_SCHEDULE" },
  { name: "PITR status", env: "X402_PRODUCTION_PITR_STATUS" },
  { name: "Monitoring URL", env: "X402_PRODUCTION_MONITORING_URL" },
  { name: "Emergency pause route", env: "X402_PRODUCTION_EMERGENCY_PAUSE_ROUTE" },
  { name: "Rollback plan", env: "X402_PRODUCTION_ROLLBACK_PLAN" },
  { name: "Release version", env: "X402_RELEASE_VERSION" },
  { name: "Release approver", env: "X402_RELEASE_APPROVER" },
  { name: "Launch scope", env: "X402_LAUNCH_SCOPE" },
];

const DANGEROUS_FLAGS = [
  "X402_ENABLE_DIRECT_SPLIT_FEES",
  "X402_ENABLE_UNATTENDED_SIGNING",
  "X402_ENABLE_BACKEND_KEY_CUSTODY",
  "X402_ENABLE_PUBLIC_NETTING",
  "X402_ENABLE_PHYSICAL_GOODS",
  "X402_ENABLE_HIGH_RISK_CATEGORIES",
  "X402_ENABLE_POLYMARKET_LIVE",
];

const SECRET_ENV_PATTERNS = [
  /TOKEN/i,
  /SECRET/i,
  /PRIVATE/i,
  /KEY/i,
  /DATABASE_URL/i,
  /HELIUS/i,
  /CHAT_ID/i,
];

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

export function redactValue(name: string, value: string | undefined): string {
  const cleaned = clean(value);
  if (!cleaned) {
    return "PENDING";
  }
  if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(name))) {
    if (cleaned.length <= 8) {
      return "REDACTED";
    }
    return `${cleaned.slice(0, 4)}...REDACTED...${cleaned.slice(-4)}`;
  }
  try {
    const url = new URL(cleaned);
    if (url.username || url.password) {
      url.username = "REDACTED";
      url.password = "REDACTED";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret/i.test(key)) {
        url.searchParams.set(key, "REDACTED");
      }
    }
    return url.toString();
  } catch {
    return cleaned;
  }
}

export function buildProductionEvidenceReport(
  env: NodeJS.ProcessEnv,
  generatedAt = new Date().toISOString(),
): ProductionEvidenceReport {
  const blockers: string[] = [];
  const checks: ProductionEvidenceCheck[] = [];

  const fields = REQUIRED_FIELDS.map((field) => {
    const present = Boolean(clean(env[field.env]));
    if (!present) {
      blockers.push(`${field.env} is required before production approval.`);
    }
    return {
      name: field.name,
      env: field.env,
      value: redactValue(field.env, env[field.env]),
      status: present ? "PRESENT" as const : "MISSING" as const,
    };
  });

  const nodeEnv = clean(env.NODE_ENV);
  if (nodeEnv !== "production") {
    blockers.push("NODE_ENV=production is required for production evidence.");
    checks.push({
      name: "node_env",
      status: "BLOCKED",
      detail: `NODE_ENV is ${nodeEnv ?? "missing"}`,
    });
  } else {
    checks.push({ name: "node_env", status: "PASS", detail: "NODE_ENV=production" });
  }

  if (clean(env.X402_DB_DRIVER) !== "postgres" || clean(env.X402_REPOSITORY_MODE) !== "postgres") {
    blockers.push("Postgres driver and repository mode are required.");
    checks.push({
      name: "postgres_mode",
      status: "BLOCKED",
      detail: "X402_DB_DRIVER=postgres and X402_REPOSITORY_MODE=postgres are required.",
    });
  } else {
    checks.push({ name: "postgres_mode", status: "PASS", detail: "Postgres mode configured." });
  }

  if (!clean(env.X402_DATABASE_URL)) {
    blockers.push("X402_DATABASE_URL is required for production Postgres evidence.");
    checks.push({ name: "database_url", status: "BLOCKED", detail: "X402_DATABASE_URL missing." });
  } else {
    checks.push({
      name: "database_url",
      status: "PASS",
      detail: redactValue("X402_DATABASE_URL", env.X402_DATABASE_URL),
    });
  }

  if (!clean(env.HELIUS_RPC) && !clean(env.HELIUS_API_KEY)) {
    blockers.push("HELIUS_RPC or HELIUS_API_KEY is required for production Solana RPC evidence.");
    checks.push({ name: "helius_rpc", status: "BLOCKED", detail: "Helius RPC not configured." });
  } else {
    checks.push({ name: "helius_rpc", status: "PASS", detail: "Helius RPC configured with secret redacted." });
  }

  for (const flag of DANGEROUS_FLAGS) {
    if (isTruthy(env[flag])) {
      blockers.push(`${flag} must remain disabled unless separately gate-approved.`);
      checks.push({ name: flag, status: "BLOCKED", detail: `${flag} is enabled.` });
    } else {
      checks.push({ name: flag, status: "PASS", detail: `${flag} disabled.` });
    }
  }

  if (clean(env.X402_PLATFORM_FEE_MODE) && !["display_only", "seller_accrual"].includes(clean(env.X402_PLATFORM_FEE_MODE)!)) {
    blockers.push("X402_PLATFORM_FEE_MODE must be display_only or seller_accrual before direct split approval.");
    checks.push({
      name: "platform_fee_mode",
      status: "BLOCKED",
      detail: `unsupported mode ${env.X402_PLATFORM_FEE_MODE}`,
    });
  } else {
    checks.push({
      name: "platform_fee_mode",
      status: "PASS",
      detail: clean(env.X402_PLATFORM_FEE_MODE) ?? "unset defaults to safe mode",
    });
  }

  return {
    version: "production_evidence_v1",
    generatedAt,
    status: blockers.length === 0 ? "PASS" : "BLOCKED",
    fields,
    checks,
    blockers,
  };
}
