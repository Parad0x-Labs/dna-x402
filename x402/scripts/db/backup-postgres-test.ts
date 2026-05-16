import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AgentBuilderRepositories, AgentBuilderService } from "../../src/agents/builder/compiler.js";
import { AgentTradingRepositories, AgentTradingService } from "../../src/agents/trading.js";
import { createPostgresClientFromEnv, databaseUrlFromEnv } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createPostgresCommerceRepositories } from "../../src/db/repositories.js";
import { backupPostgres } from "./backup.js";
import { restorePostgres } from "./restore.js";

function agentRepos(repos: ReturnType<typeof createPostgresCommerceRepositories>): AgentTradingRepositories {
  return {
    agentWallets: repos.agent_wallets as AgentTradingRepositories["agentWallets"],
    paperAgentAccounts: repos.paper_agent_accounts as AgentTradingRepositories["paperAgentAccounts"],
    agentProfiles: repos.agent_profiles as AgentTradingRepositories["agentProfiles"],
    alphaMonetizationConfigs: repos.alpha_monetization_configs as AgentTradingRepositories["alphaMonetizationConfigs"],
    copySettings: repos.copy_settings as AgentTradingRepositories["copySettings"],
    copyDecisions: repos.copy_decisions as AgentTradingRepositories["copyDecisions"],
    copiedLots: repos.copied_lots as AgentTradingRepositories["copiedLots"],
    alphaFeeAccruals: repos.alpha_fee_accruals as AgentTradingRepositories["alphaFeeAccruals"],
    agentActionLedgers: repos.agent_action_ledgers as AgentTradingRepositories["agentActionLedgers"],
  };
}

function builderRepos(repos: ReturnType<typeof createPostgresCommerceRepositories>): AgentBuilderRepositories {
  return {
    drafts: repos.agent_builder_drafts as AgentBuilderRepositories["drafts"],
    recipes: repos.agent_recipes as AgentBuilderRepositories["recipes"],
    events: repos.agent_builder_events as AgentBuilderRepositories["events"],
  };
}

function requirePostgresTooling(): void {
  if (!databaseUrlFromEnv()) {
    throw new Error("X402_DATABASE_URL is required for db:backup:test:postgres");
  }
  const pgDump = process.env.X402_PG_DUMP_BIN ?? "pg_dump";
  const psql = process.env.X402_PSQL_BIN ?? "psql";
  execFileSync(pgDump, ["--version"], { stdio: "pipe" });
  execFileSync(psql, ["--version"], { stdio: "pipe" });
}

async function resetAndMigrate(): Promise<void> {
  const { MODULAR_COMMERCE_TABLES } = await import("../../src/db/schema/tables.js");
  const db = createPostgresClientFromEnv();
  try {
    for (const table of [...MODULAR_COMMERCE_TABLES].reverse()) {
      await db.query(`drop table if exists ${table} cascade`);
    }
    await db.query("drop table if exists schema_migrations cascade");
    await db.query("drop function if exists dna_x402_touch_updated_at() cascade");
    await runMigrations(db, path.resolve("src/db/migrations"));
  } finally {
    await db.close?.();
  }
}

async function seedCriticalState(): Promise<void> {
  const db = createPostgresClientFromEnv();
  try {
    const repos = createPostgresCommerceRepositories(db);
    await repos.seller_profiles.put("seller-restore", { sellerProfileId: "seller-restore", status: "ACTIVE", primaryWallet: "wallet-a" });
    await repos.marketplace_listings.put("listing-restore", { listingId: "listing-restore", disabled: false });
    await repos.listing_manifest_versions.append("listing-restore:v1", { listingId: "listing-restore", version: 1, manifestHash: "manifest-v1" });
    await repos.policy_decisions.append("decision-restore", { decisionId: "decision-restore", state: "ALLOW" });
    await repos.seller_policy_strikes.put("seller-restore:strikes", { sellerProfileId: "seller-restore", count: 2 });
    await repos.denylist_entries.append("deny-restore", { subjectType: "LISTING", subjectValue: "bad", status: "ACTIVE", evidenceRefs: ["ticket-1"] });
    await repos.policy_appeals.put("appeal-restore", { appealId: "appeal-restore", status: "OPEN" });
    await repos.seller_tax_aggregates.put("tax-restore", { sellerProfileId: "seller-restore", grossPayments: "1000" });
    await repos.mutable_personal_records.put("personal-restore", { actorId: "actor-1", encryptedPayload: "cipher" });
    await repos.data_subject_requests.put("dsr-restore", { requestId: "dsr-restore", status: "OPEN" });
    await repos.agent_spend_policies.put("agent-policy-restore", { agentId: "agent-1", maxSpendPerDay: "100" });
    await repos.fee_waterfalls.append("fee-restore", { noDoubleChargeKey: "fee-key-restore", grossAmount: "100" });
    await repos.fee_accruals.append("fee-accrual-restore", {
      receiptId: "receipt-restore",
      quoteId: "quote-restore",
      feeKind: "BUILDER_FEE",
      amount: "50",
      recipient: "builder-treasury-restore",
      status: "ACCRUED_NOT_COLLECTED",
    });
    await repos.receipts.append("receipt-restore", { receiptId: "receipt-restore", receiptHash: "receipt-hash-restore" });
    await repos.webhook_replay_keys.append("webhook-restore", { idempotencyKey: "webhook-restore" });
    await repos.emergency_pause_state.put("global", { quotePaused: true, finalizePaused: true, reason: "restore drill" });

    const agentTrading = new AgentTradingService(() => new Date("2026-05-16T10:30:00.000Z"), agentRepos(repos));
    await agentTrading.registerWallet("agent-restore", {
      ownerWallet: "mother-wallet-restore",
      publicKey: "agent-wallet-restore",
      chain: "SOLANA",
      keyStorage: "LOCAL_ENCRYPTED",
    });
    await agentTrading.createPaperAccount("agent-restore");
    await agentTrading.recordPaperTrade("agent-restore", {
      marketId: "paper-market-restore",
      side: "YES",
      amountAtomic: "5000000",
      priceBps: 5000,
      realizedPnlAtomic: "125000",
    });
    await agentTrading.updateProfile("agent-restore", {
      visibility: "PUBLIC",
      averageEntryPriceBps: 5000,
      tradeCount: 1,
      totalVolumeAtomic: "5000000",
    });
    await agentTrading.setMonetization("alpha-restore", { enabled: true, successFeeBps: 100, mode: "ACCRUAL" });
    await agentTrading.createCopySettings({
      copySettingsId: "copy-settings-restore",
      followerAgentId: "agent-restore",
      sourceAgentId: "alpha-restore",
      enabled: true,
      mode: "PAPER_COPY",
      copyBuys: true,
      copySells: true,
      copyExits: true,
      minEntryPriceBps: 4000,
      maxEntryPriceBps: 6000,
      maxBetSizeAtomic: "250000",
      maxDailySpendAtomic: "1000000",
      maxOpenExposureAtomic: "500000",
      useSourceExitRules: false,
      customTakeProfitBps: 2000,
      customStopLossBps: 1000,
      requireApprovalAlways: false,
    });
    const decision = await agentTrading.decide({
      copySettingsId: "copy-settings-restore",
      sourceAction: {
        sourceActionId: "source-restore",
        sourceAgentId: "alpha-restore",
        actionType: "BUY",
        marketId: "market-restore",
        category: "prediction_research",
        side: "YES",
        entryPriceBps: 5000,
        sizeAtomic: "100000",
      },
      createLot: true,
    });
    await agentTrading.finalizeCopiedLot(decision.copiedLot!.copiedLotId, {
      realizedPnlAtomic: "100000",
      finalized: true,
    });

    const agentBuilder = new AgentBuilderService(() => new Date("2026-05-16T10:32:00.000Z"), builderRepos(repos));
    const draft = await agentBuilder.createDraft({
      inputMode: "PROMPT",
      ownerWallet: "builder-owner-restore",
      prompt: [
        "Create a Polymarket copy agent that follows BTC 5m markets,",
        "only copies entries between 40c and 60c, max $5 per bet,",
        "stops after $25 daily loss, max open exposure $100,",
        "copies buys only, and charges followers 2% of profit.",
      ].join(" "),
    });
    if (!draft.draftId || !draft.riskSummary || !draft.agentConfig) {
      throw new Error("agent builder restore seed failed: draft missing");
    }
    const confirmed = await agentBuilder.confirmDraft({
      draftId: draft.draftId,
      ownerWallet: "builder-owner-restore",
      acceptedRiskSummary: true,
      confirmations: draft.riskSummary.requiredConfirmations,
    });
    await agentBuilder.createRecipe({
      ownerWallet: "builder-owner-restore",
      title: "Restore Builder Recipe",
      description: "Backup/restore builder recipe.",
      config: confirmed.agentConfig,
      riskSummary: confirmed.riskSummary,
      visibility: "CLONEABLE",
      source: "PROMPT",
    });
  } finally {
    await db.close?.();
  }
}

async function verifyCriticalState(): Promise<void> {
  const db = createPostgresClientFromEnv();
  try {
    const repos = createPostgresCommerceRepositories(db);
    const required = [
      repos.seller_profiles.get("seller-restore"),
      repos.marketplace_listings.get("listing-restore"),
      repos.listing_manifest_versions.get("listing-restore:v1"),
      repos.policy_decisions.get("decision-restore"),
      repos.seller_policy_strikes.get("seller-restore:strikes"),
      repos.denylist_entries.get("deny-restore"),
      repos.policy_appeals.get("appeal-restore"),
      repos.seller_tax_aggregates.get("tax-restore"),
      repos.mutable_personal_records.get("personal-restore"),
      repos.data_subject_requests.get("dsr-restore"),
      repos.agent_spend_policies.get("agent-policy-restore"),
      repos.fee_waterfalls.get("fee-restore"),
      repos.fee_accruals.get("fee-accrual-restore"),
      repos.receipts.get("receipt-restore"),
      repos.webhook_replay_keys.get("webhook-restore"),
      repos.emergency_pause_state.get("global"),
      repos.agent_wallets.get((await repos.agent_wallets.list()).find((row) => row.payload && typeof row.payload === "object" && (row.payload as { publicKey?: string }).publicKey === "agent-wallet-restore")?.id ?? "missing-agent-wallet"),
      repos.paper_agent_accounts.get("agent-restore"),
      repos.agent_profiles.get("agent-restore"),
      repos.alpha_monetization_configs.get("alpha-restore"),
      repos.copy_settings.get("copy-settings-restore"),
      repos.agent_builder_drafts.list().then((rows) => rows.find((row) => row.payload.ownerWallet === "builder-owner-restore")),
      repos.agent_recipes.list().then((rows) => rows.find((row) => row.payload.title === "Restore Builder Recipe")),
    ];
    const rows = await Promise.all(required);
    if (rows.some((row) => !row)) {
      throw new Error("Postgres restore verification failed: critical row missing");
    }
    const agentTrading = new AgentTradingService(() => new Date("2026-05-16T10:31:00.000Z"), agentRepos(repos));
    const wallets = await agentTrading.listWallets("agent-restore");
    if (wallets.length !== 1 || wallets[0].backendHasPrivateKey !== false) {
      throw new Error("Postgres restore verification failed: agent wallet missing or custody flag invalid");
    }
    const account = await agentTrading.getPaperAccount("agent-restore");
    if (account?.currentBalanceAtomic !== "10000125000") {
      throw new Error("Postgres restore verification failed: paper account balance mismatch");
    }
    const accruals = await agentTrading.listAlphaAccruals();
    const accrual = accruals.find((item) => item.sourceAgentId === "alpha-restore");
    if (!accrual || accrual.feeAmountAtomic !== "1000" || accrual.profitBasisAtomic !== "100000") {
      throw new Error("Postgres restore verification failed: alpha fee accrual mismatch");
    }
    const lots = await agentTrading.listCopiedLots("agent-restore");
    const lot = lots.find((item) => item.sourceAgentId === "alpha-restore");
    if (!lot || lot.status !== "CLOSED_WIN") {
      throw new Error("Postgres restore verification failed: copied lot missing");
    }
    try {
      await agentTrading.finalizeCopiedLot(lot.copiedLotId, { realizedPnlAtomic: "100000", finalized: true });
      throw new Error("Postgres restore verification failed: copied lot re-finalized");
    } catch (error) {
      if (!(error instanceof Error) || !/finalized twice/i.test(error.message)) {
        throw error;
      }
    }
    const ledger = await agentTrading.listActionLedger();
    if (!ledger.some((entry) => entry.kind === "PAPER_TRADE" && entry.agentId === "agent-restore")) {
      throw new Error("Postgres restore verification failed: agent action ledger missing");
    }
    const containsForbiddenKeyMaterial = (value: unknown): boolean => {
      if (Array.isArray(value)) {
        return value.some(containsForbiddenKeyMaterial);
      }
      if (!value || typeof value !== "object") {
        return false;
      }
      for (const [key, nested] of Object.entries(value)) {
        if (/^(privateKey|seedPhrase|mnemonic|walletDump|secretKey)$/i.test(key)) {
          return true;
        }
        if (containsForbiddenKeyMaterial(nested)) {
          return true;
        }
      }
      return false;
    };
    if (containsForbiddenKeyMaterial({ wallets, account, lots, accruals, ledger })) {
      throw new Error("Postgres restore verification failed: private key material present in agent/copy records");
    }
    const agentBuilder = new AgentBuilderService(() => new Date("2026-05-16T10:33:00.000Z"), builderRepos(repos));
    const recipes = await agentBuilder.publicRecipes();
    const recipe = recipes.find((item) => item.title === "Restore Builder Recipe");
    if (!recipe || recipe.visibility !== "CLONEABLE") {
      throw new Error("Postgres restore verification failed: agent builder recipe missing");
    }
    const clone = await agentBuilder.cloneRecipe(recipe.recipeId, "builder-clone-restore");
    if (clone.status !== "DRAFT_CREATED" || clone.agentConfig?.copySettings?.minEntryPriceBps !== 4000) {
      throw new Error("Postgres restore verification failed: agent builder clone failed");
    }
    const builderEvents = await agentBuilder.listEvents();
    if (!builderEvents.some((event) => event.kind === "AGENT_BUILDER_DRAFT_CONFIRMED")) {
      throw new Error("Postgres restore verification failed: agent builder events missing");
    }
  } finally {
    await db.close?.();
  }
}

requirePostgresTooling();
await resetAndMigrate();
await seedCriticalState();
const backupDir = path.resolve(".runtime/postgres-backups");
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = backupPostgres(backupDir);
await resetAndMigrate();
restorePostgres(backupPath);
await verifyCriticalState();

console.log(JSON.stringify({ ok: true, backupPath, restored: true }, null, 2));
