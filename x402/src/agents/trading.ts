import crypto from "node:crypto";
import { stableHash } from "../common/stable.js";
import { DurableRepository } from "../db/schema/tables.js";

export type AgentChain = "SOLANA" | "POLYMARKET_POLYGON" | "EVM" | "OTHER";
export type AgentKeyStorage = "LOCAL_ENCRYPTED" | "USER_EXPORTED" | "SESSION_ONLY" | "EXTERNAL_WALLET";

export interface AgentWallet {
  walletId: string;
  ownerWallet: string;
  agentId: string;
  publicKey: string;
  chain: AgentChain;
  custodyModel: "CLIENT_SIDE_USER_OWNED";
  keyStorage: AgentKeyStorage;
  backendHasPrivateKey: false;
  createdAt: string;
}

export interface AgentWalletRegistrationInput {
  ownerWallet: string;
  publicKey: string;
  chain: AgentChain;
  keyStorage?: AgentKeyStorage;
  metadata?: Record<string, unknown>;
}

export interface PaperAgentAccount {
  agentId: string;
  startingBalanceAtomic: string;
  currentBalanceAtomic: string;
  realizedPnlAtomic: string;
  unrealizedPnlAtomic: string;
  totalVolumeAtomic: string;
  createdAt: string;
}

export interface PaperTradeInput {
  marketId: string;
  side: "YES" | "NO" | "BUY" | "SELL";
  amountAtomic: string;
  priceBps?: number;
  realizedPnlAtomic?: string;
  unrealizedPnlAtomic?: string;
}

export interface PaperLedgerEvent extends PaperTradeInput {
  eventId: string;
  agentId: string;
  token: "PAPER_USDC";
  createdAt: string;
}

export type AgentActionLedgerKind =
  | "AGENT_WALLET_REGISTERED"
  | "PAPER_TRADE"
  | "COPY_DECISION"
  | "COPIED_LOT_OPENED"
  | "COPIED_LOT_FINALIZED";

export interface AgentActionLedgerEntry {
  actionLedgerId: string;
  kind: AgentActionLedgerKind;
  agentId?: string;
  sourceAgentId?: string;
  followerAgentId?: string;
  copySettingsId?: string;
  copiedLotId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type AgentTradingMode =
  | "PAPER"
  | "SIGNAL_ONLY"
  | "USER_CONFIRMED_LIVE"
  | "AUTO_COPY_PUBLIC_BETA"
  | "GATED_SESSION_LIVE";

export type AgentProfileVisibility = "PRIVATE" | "PUBLIC";

export interface AgentProfileStats {
  agentId: string;
  visibility: AgentProfileVisibility;
  modeBadge: "PAPER" | "LIVE_VERIFIED" | "MIXED" | "UNVERIFIED";
  totalPnlAtomic: string;
  roiBps: number;
  winRateBps: number;
  averageEntryPriceBps: number;
  medianEntryPriceBps: number;
  totalVolumeAtomic: string;
  tradeCount: number;
  resolvedTradeCount: number;
  averageBetSizeAtomic: string;
  maxDrawdownBps: number;
  copiedFollowerProfitAtomic: string;
  copiedFollowerLossAtomic: string;
  copiedVolumeAtomic: string;
  followerCount: number;
  last30dPnlAtomic: string;
  last30dRoiBps: number;
  badges: string[];
}

export interface AlphaMonetizationConfig {
  sourceAgentId: string;
  enabled: boolean;
  successFeeBps: 50 | 100 | 150 | 200 | 250 | 300;
  appliesTo: "POSITIVE_FINALIZED_COPIED_LOT_PNL";
  mode: "DISPLAY_ONLY" | "ACCRUAL" | "DIRECT_SPLIT_GATED";
  changedAt: string;
}

export interface AlphaFeeAccrual {
  accrualId: string;
  sourceAgentId: string;
  followerAgentId: string;
  copiedLotId: string;
  feeBps: number;
  profitBasisAtomic: string;
  feeAmountAtomic: string;
  token: "USDC" | "PAPER_USDC";
  status: "ACCRUED_NOT_COLLECTED" | "COLLECTED_DIRECT_SPLIT" | "WAIVED" | "REFUNDED" | "DISPUTED";
  createdAt: string;
}

export interface CopySettings {
  copySettingsId: string;
  followerAgentId: string;
  sourceAgentId: string;
  enabled: boolean;
  mode: "WATCH_ONLY" | "PAPER_COPY" | "USER_CONFIRMED_COPY" | "AUTO_COPY_PUBLIC_BETA";
  copyBuys: boolean;
  copySells: boolean;
  copyExits: boolean;
  minEntryPriceBps?: number;
  maxEntryPriceBps?: number;
  maxBetSizeAtomic: string;
  maxDailySpendAtomic: string;
  maxOpenExposureAtomic: string;
  maxDailyLossAtomic?: string;
  useSourceExitRules: boolean;
  customTakeProfitBps?: number;
  customStopLossBps?: number;
  allowedMarketIds?: string[];
  blockedMarketIds?: string[];
  allowedCategories?: string[];
  blockedCategories?: string[];
  maxSlippageBps?: number;
  maxPriceDriftBps?: number;
  requireApprovalAboveAtomic?: string;
  requireApprovalAlways: boolean;
  stopCopyAfterDrawdownBps?: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type CopyReasonCode =
  | "COPY_ENABLED"
  | "COPY_DISABLED"
  | "COPY_BUYS_DISABLED"
  | "COPY_SELLS_DISABLED"
  | "COPY_EXITS_DISABLED"
  | "ENTRY_PRICE_BELOW_MIN"
  | "ENTRY_PRICE_ABOVE_MAX"
  | "MARKET_BLOCKED"
  | "CATEGORY_BLOCKED"
  | "MAX_BET_SIZE_EXCEEDED"
  | "MAX_DAILY_SPEND_EXCEEDED"
  | "MAX_OPEN_EXPOSURE_EXCEEDED"
  | "MAX_DAILY_LOSS_EXCEEDED"
  | "SLIPPAGE_TOO_HIGH"
  | "PRICE_DRIFT_TOO_HIGH"
  | "APPROVAL_REQUIRED"
  | "EMERGENCY_PAUSED"
  | "LIVE_COPY_GATED"
  | "SOURCE_AGENT_NOT_ALLOWED"
  | "COPY_SETTINGS_EXPIRED";

export type CopyDecision =
  | {
    decision: "COPY";
    reasonCodes: CopyReasonCode[];
    copyScaleAtomic: string;
    requiresUserApproval: boolean;
  }
  | {
    decision: "SKIP";
    reasonCodes: CopyReasonCode[];
  }
  | {
    decision: "REVIEW_REQUIRED";
    reasonCodes: CopyReasonCode[];
  };

export interface SourceAgentAction {
  sourceActionId: string;
  sourceAgentId: string;
  actionType: "BUY" | "SELL" | "EXIT";
  marketId: string;
  category?: string;
  side: "YES" | "NO" | "BUY" | "SELL";
  entryPriceBps: number;
  sizeAtomic: string;
  slippageBps?: number;
  priceDriftBps?: number;
  sourceAgentAllowed?: boolean;
}

export interface CopyDecisionInput {
  copySettingsId?: string;
  settings?: CopySettings;
  sourceAction: SourceAgentAction;
  currentDailySpendAtomic?: string;
  currentOpenExposureAtomic?: string;
  currentDailyLossAtomic?: string;
  emergencyPaused?: boolean;
  liveCopyGateAllowed?: boolean;
  createLot?: boolean;
}

export interface CopiedLot {
  copiedLotId: string;
  sourceAgentId: string;
  followerAgentId: string;
  copySettingsId: string;
  sourceActionId: string;
  followerActionId?: string;
  marketId: string;
  side: "YES" | "NO" | "BUY" | "SELL";
  entryPriceBps: number;
  entrySizeAtomic: string;
  copyMode: "PAPER_COPY" | "USER_CONFIRMED_COPY" | "AUTO_COPY_PUBLIC_BETA";
  alphaFeeBpsAtEntry?: number;
  followerTakeProfitBps?: number;
  followerStopLossBps?: number;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_BREAK_EVEN" | "CANCELLED" | "EXPIRED";
  realizedPnlAtomic?: string;
  alphaFeeAccrualId?: string;
  openedAt: string;
  closedAt?: string;
}

export interface CopyDecisionResult {
  copyDecisionId?: string;
  decision: CopyDecision;
  copiedLot?: CopiedLot;
}

export interface PersistedCopyDecision {
  copyDecisionId: string;
  copySettingsId: string;
  sourceAgentId: string;
  followerAgentId: string;
  sourceActionId: string;
  decision: CopyDecision;
  sourceAction: SourceAgentAction;
  copiedLotId?: string;
  createdAt: string;
}

export interface AgentTradingRepositories {
  agentWallets: DurableRepository<AgentWallet>;
  paperAgentAccounts: DurableRepository<PaperAgentAccount>;
  agentProfiles: DurableRepository<AgentProfileStats>;
  alphaMonetizationConfigs: DurableRepository<AlphaMonetizationConfig>;
  copySettings: DurableRepository<CopySettings>;
  copyDecisions: DurableRepository<PersistedCopyDecision>;
  copiedLots: DurableRepository<CopiedLot>;
  alphaFeeAccruals: DurableRepository<AlphaFeeAccrual>;
  agentActionLedgers: DurableRepository<AgentActionLedgerEntry>;
}

export class AgentTradingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export const PAPER_USDC_STARTING_BALANCE_ATOMIC = "10000000000";
export const ALLOWED_ALPHA_SUCCESS_FEE_BPS = [50, 100, 150, 200, 250, 300] as const;

const PRIVATE_KEY_FIELD_PATTERNS = [
  /private[_-]?key/i,
  /secret[_-]?key/i,
  /seed[_-]?phrase/i,
  /mnemonic/i,
  /wallet[_-]?dump/i,
  /decrypted[_-]?signer/i,
  /^keypair$/i,
  /^secret$/i,
];

function isAutoCopyLiveMode(mode: CopySettings["mode"]): boolean {
  return mode === "AUTO_COPY_PUBLIC_BETA";
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function assertAtomicString(value: string, field: string): void {
  if (!/^\d+$/.test(value)) {
    throw new AgentTradingError("INVALID_ATOMIC_AMOUNT", `${field} must be an unsigned atomic string`);
  }
}

function addAtomic(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

function subAtomic(left: string, right: string): string {
  return (BigInt(left) - BigInt(right)).toString();
}

function gtAtomic(left: string | undefined, right: string | undefined): boolean {
  return BigInt(left ?? "0") > BigInt(right ?? "0");
}

function gteAtomic(left: string | undefined, right: string | undefined): boolean {
  return BigInt(left ?? "0") >= BigInt(right ?? "0");
}

function includesValue(values: string[] | undefined, value: string | undefined): boolean {
  return Boolean(value && values?.includes(value));
}

function hasPrivateKeyMaterial(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasPrivateKeyMaterial(item));
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_KEY_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
      return true;
    }
    if (hasPrivateKeyMaterial(nested)) {
      return true;
    }
  }
  return false;
}

export function assertNoBackendPrivateKeyPayload(payload: unknown): void {
  if (hasPrivateKeyMaterial(payload)) {
    throw new AgentTradingError(
      "PRIVATE_KEY_FORBIDDEN",
      "Backend agent-wallet APIs accept public keys only. Private keys, seed phrases, keypairs, and wallet dumps are forbidden.",
      400,
    );
  }
}

function defaultStats(agentId: string): AgentProfileStats {
  return {
    agentId,
    visibility: "PRIVATE",
    modeBadge: "UNVERIFIED",
    totalPnlAtomic: "0",
    roiBps: 0,
    winRateBps: 0,
    averageEntryPriceBps: 0,
    medianEntryPriceBps: 0,
    totalVolumeAtomic: "0",
    tradeCount: 0,
    resolvedTradeCount: 0,
    averageBetSizeAtomic: "0",
    maxDrawdownBps: 0,
    copiedFollowerProfitAtomic: "0",
    copiedFollowerLossAtomic: "0",
    copiedVolumeAtomic: "0",
    followerCount: 0,
    last30dPnlAtomic: "0",
    last30dRoiBps: 0,
    badges: ["LOW_SAMPLE_SIZE"],
  };
}

function deriveBadges(stats: AgentProfileStats): string[] {
  const badges = new Set(stats.badges.filter((badge) => badge.trim().length > 0));
  if (stats.modeBadge === "PAPER") badges.add("PAPER_ONLY");
  if (stats.modeBadge === "LIVE_VERIFIED") badges.add("LIVE_VERIFIED");
  if (stats.tradeCount < 20) {
    badges.add("LOW_SAMPLE_SIZE");
    badges.add("SMALL_SAMPLE");
  }
  if (stats.averageEntryPriceBps >= 8000) badges.add("HIGH_AVG_ENTRY");
  if (stats.maxDrawdownBps >= 2500) badges.add("HIGH_DRAWDOWN");
  if (BigInt(stats.copiedFollowerProfitAtomic) > 0n) badges.add("PROFITABLE_FOLLOWERS");
  if (BigInt(stats.copiedFollowerLossAtomic) > 0n) badges.add("NEGATIVE_FOLLOWER_PNL");
  if (BigInt(stats.totalVolumeAtomic) >= 1_000_000_000n) badges.add("HIGH_VOLUME");
  return Array.from(badges).sort();
}

function defaultCopySettings(input: {
  copySettingsId?: string;
  followerAgentId: string;
  sourceAgentId: string;
  now: string;
}): CopySettings {
  return {
    copySettingsId: input.copySettingsId ?? crypto.randomUUID(),
    followerAgentId: input.followerAgentId,
    sourceAgentId: input.sourceAgentId,
    enabled: true,
    mode: "WATCH_ONLY",
    copyBuys: true,
    copySells: false,
    copyExits: false,
    maxBetSizeAtomic: "0",
    maxDailySpendAtomic: "0",
    maxOpenExposureAtomic: "0",
    useSourceExitRules: true,
    requireApprovalAlways: true,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export class AgentTradingService {
  private readonly wallets = new Map<string, AgentWallet[]>();
  private readonly paperAccounts = new Map<string, PaperAgentAccount>();
  private readonly paperLedger: PaperLedgerEvent[] = [];
  private readonly profiles = new Map<string, AgentProfileStats>();
  private readonly monetization = new Map<string, AlphaMonetizationConfig>();
  private readonly copySettings = new Map<string, CopySettings>();
  private readonly copyDecisions = new Map<string, PersistedCopyDecision>();
  private readonly copiedLots = new Map<string, CopiedLot>();
  private readonly alphaAccruals = new Map<string, AlphaFeeAccrual>();
  private readonly actionLedger = new Map<string, AgentActionLedgerEntry>();
  private loadPromise?: Promise<void>;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly repositories?: AgentTradingRepositories,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (!this.repositories) return;
    this.loadPromise ??= this.loadFromRepositories();
    await this.loadPromise;
  }

  private async loadFromRepositories(): Promise<void> {
    const repos = this.repositories;
    if (!repos) return;

    const [
      wallets,
      paperAccounts,
      profiles,
      monetization,
      copySettingsRows,
      copyDecisions,
      copiedLots,
      alphaAccruals,
      actionLedger,
    ] = await Promise.all([
      repos.agentWallets.list(),
      repos.paperAgentAccounts.list(),
      repos.agentProfiles.list(),
      repos.alphaMonetizationConfigs.list(),
      repos.copySettings.list(),
      repos.copyDecisions.list(),
      repos.copiedLots.list(),
      repos.alphaFeeAccruals.list(),
      repos.agentActionLedgers.list(),
    ]);

    this.wallets.clear();
    for (const row of wallets) {
      const current = this.wallets.get(row.payload.agentId) ?? [];
      current.push(row.payload);
      this.wallets.set(row.payload.agentId, current);
    }

    this.paperAccounts.clear();
    for (const row of paperAccounts) this.paperAccounts.set(row.payload.agentId, row.payload);

    this.profiles.clear();
    for (const row of profiles) this.profiles.set(row.payload.agentId, row.payload);

    this.monetization.clear();
    for (const row of monetization) this.monetization.set(row.payload.sourceAgentId, row.payload);

    this.copySettings.clear();
    for (const row of copySettingsRows) this.copySettings.set(row.payload.copySettingsId, row.payload);

    this.copyDecisions.clear();
    for (const row of copyDecisions) this.copyDecisions.set(row.payload.copyDecisionId, row.payload);

    this.copiedLots.clear();
    for (const row of copiedLots) this.copiedLots.set(row.payload.copiedLotId, row.payload);

    this.alphaAccruals.clear();
    for (const row of alphaAccruals) this.alphaAccruals.set(row.payload.accrualId, row.payload);

    this.actionLedger.clear();
    this.paperLedger.splice(0);
    for (const row of actionLedger) {
      this.actionLedger.set(row.payload.actionLedgerId, row.payload);
      if (row.payload.kind === "PAPER_TRADE") {
        this.paperLedger.push(row.payload.payload as unknown as PaperLedgerEvent);
      }
    }
  }

  private async persistAction(entry: AgentActionLedgerEntry): Promise<void> {
    this.actionLedger.set(entry.actionLedgerId, entry);
    await this.repositories?.agentActionLedgers.append(entry.actionLedgerId, entry, { actorId: entry.agentId ?? entry.followerAgentId ?? "agent-control-plane" });
  }

  async registerWallet(agentId: string, input: AgentWalletRegistrationInput): Promise<AgentWallet> {
    await this.ensureLoaded();
    assertNoBackendPrivateKeyPayload(input);
    if (!agentId.trim()) throw new AgentTradingError("AGENT_ID_REQUIRED", "agentId is required");
    if (!input.ownerWallet?.trim()) throw new AgentTradingError("OWNER_WALLET_REQUIRED", "ownerWallet is required");
    if (!input.publicKey?.trim()) throw new AgentTradingError("PUBLIC_KEY_REQUIRED", "publicKey is required");

    const wallet: AgentWallet = {
      walletId: crypto.randomUUID(),
      ownerWallet: input.ownerWallet,
      agentId,
      publicKey: input.publicKey,
      chain: input.chain,
      custodyModel: "CLIENT_SIDE_USER_OWNED",
      keyStorage: input.keyStorage ?? "LOCAL_ENCRYPTED",
      backendHasPrivateKey: false,
      createdAt: nowIso(this.now),
    };
    const current = this.wallets.get(agentId) ?? [];
    current.push(wallet);
    this.wallets.set(agentId, current);
    await this.repositories?.agentWallets.put(wallet.walletId, wallet, { actorId: wallet.ownerWallet });
    await this.persistAction({
      actionLedgerId: `wallet:${wallet.walletId}`,
      kind: "AGENT_WALLET_REGISTERED",
      agentId,
      payload: { walletId: wallet.walletId, ownerWallet: wallet.ownerWallet, publicKey: wallet.publicKey, chain: wallet.chain },
      createdAt: wallet.createdAt,
    });
    return wallet;
  }

  async listWallets(agentId: string): Promise<AgentWallet[]> {
    await this.ensureLoaded();
    return [...(this.wallets.get(agentId) ?? [])];
  }

  async createPaperAccount(agentId: string): Promise<PaperAgentAccount> {
    await this.ensureLoaded();
    const existing = this.paperAccounts.get(agentId);
    if (existing) return { ...existing };
    const account: PaperAgentAccount = {
      agentId,
      startingBalanceAtomic: PAPER_USDC_STARTING_BALANCE_ATOMIC,
      currentBalanceAtomic: PAPER_USDC_STARTING_BALANCE_ATOMIC,
      realizedPnlAtomic: "0",
      unrealizedPnlAtomic: "0",
      totalVolumeAtomic: "0",
      createdAt: nowIso(this.now),
    };
    this.paperAccounts.set(agentId, account);
    await this.repositories?.paperAgentAccounts.put(agentId, account, { actorId: agentId });
    const profile = this.profileSync(agentId);
    this.profiles.set(agentId, { ...profile, modeBadge: "PAPER", badges: deriveBadges({ ...profile, modeBadge: "PAPER" }) });
    await this.repositories?.agentProfiles.put(agentId, this.profiles.get(agentId)!, { actorId: agentId });
    return { ...account };
  }

  async getPaperAccount(agentId: string): Promise<PaperAgentAccount | undefined> {
    await this.ensureLoaded();
    const account = this.paperAccounts.get(agentId);
    return account ? { ...account } : undefined;
  }

  async recordPaperTrade(agentId: string, input: PaperTradeInput): Promise<{ account: PaperAgentAccount; event: PaperLedgerEvent }> {
    await this.ensureLoaded();
    assertAtomicString(input.amountAtomic, "amountAtomic");
    if (input.realizedPnlAtomic) assertAtomicString(input.realizedPnlAtomic.replace(/^-/, ""), "realizedPnlAtomic");
    if (input.unrealizedPnlAtomic) assertAtomicString(input.unrealizedPnlAtomic.replace(/^-/, ""), "unrealizedPnlAtomic");
    const account = this.paperAccounts.get(agentId) ?? await this.createPaperAccount(agentId);
    const realized = input.realizedPnlAtomic ?? "0";
    const unrealized = input.unrealizedPnlAtomic ?? account.unrealizedPnlAtomic;
    const updated: PaperAgentAccount = {
      ...account,
      currentBalanceAtomic: addAtomic(account.currentBalanceAtomic, realized),
      realizedPnlAtomic: addAtomic(account.realizedPnlAtomic, realized),
      unrealizedPnlAtomic: unrealized,
      totalVolumeAtomic: addAtomic(account.totalVolumeAtomic, input.amountAtomic),
    };
    const event: PaperLedgerEvent = {
      ...input,
      eventId: crypto.randomUUID(),
      agentId,
      token: "PAPER_USDC",
      createdAt: nowIso(this.now),
    };
    this.paperAccounts.set(agentId, updated);
    this.paperLedger.push(event);
    await this.repositories?.paperAgentAccounts.put(agentId, updated, { actorId: agentId });
    await this.persistAction({
      actionLedgerId: `paper:${event.eventId}`,
      kind: "PAPER_TRADE",
      agentId,
      payload: event as unknown as Record<string, unknown>,
      createdAt: event.createdAt,
    });
    const profile = this.profileSync(agentId);
    const tradeCount = profile.tradeCount + 1;
    const nextProfile: AgentProfileStats = {
      ...profile,
      modeBadge: "PAPER",
      totalPnlAtomic: updated.realizedPnlAtomic,
      totalVolumeAtomic: updated.totalVolumeAtomic,
      tradeCount,
      resolvedTradeCount: input.realizedPnlAtomic ? profile.resolvedTradeCount + 1 : profile.resolvedTradeCount,
      averageEntryPriceBps: input.priceBps ?? profile.averageEntryPriceBps,
      averageBetSizeAtomic: tradeCount > 0 ? (BigInt(updated.totalVolumeAtomic) / BigInt(tradeCount)).toString() : "0",
      badges: deriveBadges({ ...profile, modeBadge: "PAPER", tradeCount, totalVolumeAtomic: updated.totalVolumeAtomic }),
    };
    this.profiles.set(agentId, nextProfile);
    await this.repositories?.agentProfiles.put(agentId, nextProfile, { actorId: agentId });
    return { account: { ...updated }, event };
  }

  private profileSync(agentId: string): AgentProfileStats {
    const existing = this.profiles.get(agentId) ?? defaultStats(agentId);
    const withBadges = { ...existing, badges: deriveBadges(existing) };
    this.profiles.set(agentId, withBadges);
    return { ...withBadges };
  }

  async profile(agentId: string): Promise<AgentProfileStats> {
    await this.ensureLoaded();
    return this.profileSync(agentId);
  }

  async updateProfile(agentId: string, patch: Partial<AgentProfileStats>): Promise<AgentProfileStats> {
    await this.ensureLoaded();
    const current = this.profileSync(agentId);
    const next: AgentProfileStats = {
      ...current,
      ...patch,
      agentId,
      badges: deriveBadges({ ...current, ...patch, agentId, badges: patch.badges ?? current.badges }),
    };
    this.profiles.set(agentId, next);
    await this.repositories?.agentProfiles.put(agentId, next, { actorId: agentId });
    return { ...next };
  }

  async leaderboard(): Promise<AgentProfileStats[]> {
    await this.ensureLoaded();
    return Array.from(this.profiles.values())
      .filter((profile) => profile.visibility === "PUBLIC")
      .map((profile) => ({ ...profile, badges: deriveBadges(profile) }))
      .sort((left, right) => right.roiBps - left.roiBps);
  }

  async setMonetization(agentId: string, input: {
    enabled: boolean;
    successFeeBps: number;
    mode?: AlphaMonetizationConfig["mode"];
  }): Promise<AlphaMonetizationConfig> {
    await this.ensureLoaded();
    if (!ALLOWED_ALPHA_SUCCESS_FEE_BPS.includes(input.successFeeBps as AlphaMonetizationConfig["successFeeBps"])) {
      throw new AgentTradingError("ALPHA_FEE_BPS_INVALID", "alpha success fee must be one of 50, 100, 150, 200, 250, or 300 bps");
    }
    const mode = input.mode ?? "ACCRUAL";
    if (mode === "DIRECT_SPLIT_GATED") {
      throw new AgentTradingError("ALPHA_DIRECT_SPLIT_GATED", "direct alpha fee settlement is blocked until explicit gate approval", 403);
    }
    const config: AlphaMonetizationConfig = {
      sourceAgentId: agentId,
      enabled: input.enabled,
      successFeeBps: input.successFeeBps as AlphaMonetizationConfig["successFeeBps"],
      appliesTo: "POSITIVE_FINALIZED_COPIED_LOT_PNL",
      mode,
      changedAt: nowIso(this.now),
    };
    this.monetization.set(agentId, config);
    await this.repositories?.alphaMonetizationConfigs.put(agentId, config, { actorId: agentId });
    return { ...config };
  }

  async getMonetization(agentId: string): Promise<AlphaMonetizationConfig | undefined> {
    await this.ensureLoaded();
    const config = this.monetization.get(agentId);
    return config ? { ...config } : undefined;
  }

  async createCopySettings(input: Partial<CopySettings> & { followerAgentId: string; sourceAgentId: string }): Promise<CopySettings> {
    await this.ensureLoaded();
    const ts = nowIso(this.now);
    const base = defaultCopySettings({
      copySettingsId: input.copySettingsId,
      followerAgentId: input.followerAgentId,
      sourceAgentId: input.sourceAgentId,
      now: ts,
    });
    const next = this.normalizeCopySettings({ ...base, ...input, createdAt: ts, updatedAt: ts });
    this.copySettings.set(next.copySettingsId, next);
    await this.repositories?.copySettings.put(next.copySettingsId, next, { actorId: next.followerAgentId });
    return { ...next };
  }

  async getCopySettings(copySettingsId: string): Promise<CopySettings | undefined> {
    await this.ensureLoaded();
    const settings = this.copySettings.get(copySettingsId);
    return settings ? { ...settings } : undefined;
  }

  async updateCopySettings(copySettingsId: string, patch: Partial<CopySettings>): Promise<CopySettings> {
    await this.ensureLoaded();
    const current = this.copySettings.get(copySettingsId);
    if (!current) throw new AgentTradingError("COPY_SETTINGS_NOT_FOUND", "copy settings not found", 404);
    const next = this.normalizeCopySettings({ ...current, ...patch, copySettingsId, updatedAt: nowIso(this.now) });
    this.copySettings.set(copySettingsId, next);
    await this.repositories?.copySettings.put(copySettingsId, next, { actorId: next.followerAgentId });
    return { ...next };
  }

  async pauseCopySettings(copySettingsId: string): Promise<CopySettings> {
    return this.updateCopySettings(copySettingsId, { enabled: false });
  }

  async decide(input: CopyDecisionInput): Promise<CopyDecisionResult> {
    await this.ensureLoaded();
    const settings = input.settings
      ? this.normalizeCopySettings(input.settings)
      : input.copySettingsId
        ? this.copySettings.get(input.copySettingsId)
        : undefined;
    if (!settings) throw new AgentTradingError("COPY_SETTINGS_NOT_FOUND", "copy settings not found", 404);

    const decision = this.evaluateCopyDecision(settings, input);
    let copiedLot: CopiedLot | undefined;
    if (input.createLot && decision.decision === "COPY") {
      copiedLot = await this.createCopiedLot(settings, input.sourceAction);
    }
    const copyDecision: PersistedCopyDecision = {
      copyDecisionId: crypto.randomUUID(),
      copySettingsId: settings.copySettingsId,
      sourceAgentId: settings.sourceAgentId,
      followerAgentId: settings.followerAgentId,
      sourceActionId: input.sourceAction.sourceActionId,
      sourceAction: input.sourceAction,
      decision,
      copiedLotId: copiedLot?.copiedLotId,
      createdAt: nowIso(this.now),
    };
    this.copyDecisions.set(copyDecision.copyDecisionId, copyDecision);
    await this.repositories?.copyDecisions.append(copyDecision.copyDecisionId, copyDecision, { actorId: settings.followerAgentId });
    await this.persistAction({
      actionLedgerId: `copy-decision:${copyDecision.copyDecisionId}`,
      kind: "COPY_DECISION",
      sourceAgentId: settings.sourceAgentId,
      followerAgentId: settings.followerAgentId,
      copySettingsId: settings.copySettingsId,
      copiedLotId: copiedLot?.copiedLotId,
      payload: copyDecision as unknown as Record<string, unknown>,
      createdAt: copyDecision.createdAt,
    });
    return { copyDecisionId: copyDecision.copyDecisionId, decision, copiedLot };
  }

  async getCopiedLot(copiedLotId: string): Promise<CopiedLot | undefined> {
    await this.ensureLoaded();
    const lot = this.copiedLots.get(copiedLotId);
    return lot ? { ...lot } : undefined;
  }

  async listCopiedLots(agentId: string): Promise<CopiedLot[]> {
    await this.ensureLoaded();
    return Array.from(this.copiedLots.values())
      .filter((lot) => lot.sourceAgentId === agentId || lot.followerAgentId === agentId)
      .map((lot) => ({ ...lot }));
  }

  async finalizeCopiedLot(copiedLotId: string, input: {
    realizedPnlAtomic: string;
    finalized?: boolean;
  }): Promise<{ lot: CopiedLot; alphaFeeAccrual?: AlphaFeeAccrual }> {
    await this.ensureLoaded();
    assertAtomicString(input.realizedPnlAtomic.replace(/^-/, ""), "realizedPnlAtomic");
    const lot = this.copiedLots.get(copiedLotId);
    if (!lot) throw new AgentTradingError("COPIED_LOT_NOT_FOUND", "copied lot not found", 404);
    if (lot.status !== "OPEN") {
      throw new AgentTradingError("COPIED_LOT_ALREADY_FINALIZED", "copied lot cannot be finalized twice", 409);
    }
    if (input.finalized === false) {
      throw new AgentTradingError("UNREALIZED_PNL_NOT_FEE_ELIGIBLE", "alpha fees apply only to finalized copied-lot PnL", 422);
    }

    const pnl = BigInt(input.realizedPnlAtomic);
    const status: CopiedLot["status"] = pnl > 0n ? "CLOSED_WIN" : pnl < 0n ? "CLOSED_LOSS" : "CLOSED_BREAK_EVEN";
    const closed: CopiedLot = {
      ...lot,
      status,
      realizedPnlAtomic: input.realizedPnlAtomic,
      closedAt: nowIso(this.now),
    };

    let accrual: AlphaFeeAccrual | undefined;
    if (pnl > 0n && closed.alphaFeeBpsAtEntry && closed.alphaFeeBpsAtEntry > 0) {
      const feeAmount = (pnl * BigInt(closed.alphaFeeBpsAtEntry)) / 10_000n;
      if (feeAmount > 0n) {
        accrual = {
          accrualId: crypto.randomUUID(),
          sourceAgentId: closed.sourceAgentId,
          followerAgentId: closed.followerAgentId,
          copiedLotId,
          feeBps: closed.alphaFeeBpsAtEntry,
          profitBasisAtomic: input.realizedPnlAtomic,
          feeAmountAtomic: feeAmount.toString(),
          token: closed.copyMode === "PAPER_COPY" ? "PAPER_USDC" : "USDC",
          status: "ACCRUED_NOT_COLLECTED",
          createdAt: nowIso(this.now),
        };
        closed.alphaFeeAccrualId = accrual.accrualId;
        this.alphaAccruals.set(accrual.accrualId, accrual);
        await this.repositories?.alphaFeeAccruals.append(accrual.accrualId, accrual, { actorId: closed.followerAgentId });
      }
    }

    this.copiedLots.set(copiedLotId, closed);
    await this.repositories?.copiedLots.put(copiedLotId, closed, { actorId: closed.followerAgentId });
    await this.persistAction({
      actionLedgerId: `copied-lot-finalized:${copiedLotId}`,
      kind: "COPIED_LOT_FINALIZED",
      sourceAgentId: closed.sourceAgentId,
      followerAgentId: closed.followerAgentId,
      copySettingsId: closed.copySettingsId,
      copiedLotId,
      payload: { status: closed.status, realizedPnlAtomic: closed.realizedPnlAtomic, alphaFeeAccrualId: closed.alphaFeeAccrualId },
      createdAt: closed.closedAt ?? nowIso(this.now),
    });
    return { lot: { ...closed }, alphaFeeAccrual: accrual ? { ...accrual } : undefined };
  }

  async listAlphaAccruals(): Promise<AlphaFeeAccrual[]> {
    await this.ensureLoaded();
    return Array.from(this.alphaAccruals.values()).map((accrual) => ({ ...accrual }));
  }

  async listActionLedger(): Promise<AgentActionLedgerEntry[]> {
    await this.ensureLoaded();
    return Array.from(this.actionLedger.values()).map((entry) => ({ ...entry }));
  }

  private normalizeCopySettings(settings: CopySettings): CopySettings {
    assertAtomicString(settings.maxBetSizeAtomic, "maxBetSizeAtomic");
    assertAtomicString(settings.maxDailySpendAtomic, "maxDailySpendAtomic");
    assertAtomicString(settings.maxOpenExposureAtomic, "maxOpenExposureAtomic");
    if (settings.maxDailyLossAtomic) assertAtomicString(settings.maxDailyLossAtomic, "maxDailyLossAtomic");
    if (settings.requireApprovalAboveAtomic) assertAtomicString(settings.requireApprovalAboveAtomic, "requireApprovalAboveAtomic");
    if (isAutoCopyLiveMode(settings.mode) && settings.requireApprovalAlways) {
      return settings;
    }
    return settings;
  }

  private evaluateCopyDecision(settings: CopySettings, input: CopyDecisionInput): CopyDecision {
    const action = input.sourceAction;
    const reasons: CopyReasonCode[] = [];
    if (input.emergencyPaused) reasons.push("EMERGENCY_PAUSED");
    if (!settings.enabled) reasons.push("COPY_DISABLED");
    if (settings.expiresAt && new Date(settings.expiresAt).getTime() <= this.now().getTime()) {
      reasons.push("COPY_SETTINGS_EXPIRED");
    }
    if (action.sourceAgentAllowed === false) reasons.push("SOURCE_AGENT_NOT_ALLOWED");
    if (isAutoCopyLiveMode(settings.mode) && !input.liveCopyGateAllowed) reasons.push("LIVE_COPY_GATED");

    if (action.actionType === "BUY" && !settings.copyBuys) reasons.push("COPY_BUYS_DISABLED");
    if (action.actionType === "SELL" && !settings.copySells) reasons.push("COPY_SELLS_DISABLED");
    if (action.actionType === "EXIT" && !settings.copyExits) reasons.push("COPY_EXITS_DISABLED");

    if (action.actionType === "BUY" && settings.minEntryPriceBps !== undefined && action.entryPriceBps < settings.minEntryPriceBps) {
      reasons.push("ENTRY_PRICE_BELOW_MIN");
    }
    if (action.actionType === "BUY" && settings.maxEntryPriceBps !== undefined && action.entryPriceBps > settings.maxEntryPriceBps) {
      reasons.push("ENTRY_PRICE_ABOVE_MAX");
    }
    if (includesValue(settings.blockedMarketIds, action.marketId)
      || (settings.allowedMarketIds && !settings.allowedMarketIds.includes(action.marketId))) {
      reasons.push("MARKET_BLOCKED");
    }
    if (includesValue(settings.blockedCategories, action.category)
      || (settings.allowedCategories && action.category && !settings.allowedCategories.includes(action.category))) {
      reasons.push("CATEGORY_BLOCKED");
    }
    if (gtAtomic(action.sizeAtomic, settings.maxBetSizeAtomic)) reasons.push("MAX_BET_SIZE_EXCEEDED");
    if (gtAtomic(addAtomic(input.currentDailySpendAtomic ?? "0", action.sizeAtomic), settings.maxDailySpendAtomic)) {
      reasons.push("MAX_DAILY_SPEND_EXCEEDED");
    }
    if (gtAtomic(addAtomic(input.currentOpenExposureAtomic ?? "0", action.sizeAtomic), settings.maxOpenExposureAtomic)) {
      reasons.push("MAX_OPEN_EXPOSURE_EXCEEDED");
    }
    if (settings.maxDailyLossAtomic && gteAtomic(input.currentDailyLossAtomic ?? "0", settings.maxDailyLossAtomic)) {
      reasons.push("MAX_DAILY_LOSS_EXCEEDED");
    }
    if (settings.maxSlippageBps !== undefined && (action.slippageBps ?? 0) > settings.maxSlippageBps) {
      reasons.push("SLIPPAGE_TOO_HIGH");
    }
    if (settings.maxPriceDriftBps !== undefined && (action.priceDriftBps ?? 0) > settings.maxPriceDriftBps) {
      reasons.push("PRICE_DRIFT_TOO_HIGH");
    }

    const hardStops = reasons.filter((reason) => reason !== "APPROVAL_REQUIRED");
    if (hardStops.length > 0) {
      return { decision: "SKIP", reasonCodes: hardStops };
    }

    if (settings.requireApprovalAlways
      || (settings.requireApprovalAboveAtomic !== undefined && gtAtomic(action.sizeAtomic, settings.requireApprovalAboveAtomic))) {
      return { decision: "REVIEW_REQUIRED", reasonCodes: ["APPROVAL_REQUIRED"] };
    }

    return {
      decision: "COPY",
      reasonCodes: ["COPY_ENABLED"],
      copyScaleAtomic: action.sizeAtomic,
      requiresUserApproval: false,
    };
  }

  private async createCopiedLot(settings: CopySettings, action: SourceAgentAction): Promise<CopiedLot> {
    const monetization = this.monetization.get(settings.sourceAgentId);
    const alphaFeeBpsAtEntry = monetization?.enabled ? monetization.successFeeBps : undefined;
    const lot: CopiedLot = {
      copiedLotId: crypto.randomUUID(),
      sourceAgentId: settings.sourceAgentId,
      followerAgentId: settings.followerAgentId,
      copySettingsId: settings.copySettingsId,
      sourceActionId: action.sourceActionId,
      marketId: action.marketId,
      side: action.side,
      entryPriceBps: action.entryPriceBps,
      entrySizeAtomic: action.sizeAtomic,
      copyMode: settings.mode === "WATCH_ONLY" ? "PAPER_COPY" : settings.mode,
      alphaFeeBpsAtEntry,
      followerTakeProfitBps: settings.useSourceExitRules ? undefined : settings.customTakeProfitBps,
      followerStopLossBps: settings.useSourceExitRules ? undefined : settings.customStopLossBps,
      status: "OPEN",
      openedAt: nowIso(this.now),
    };
    this.copiedLots.set(lot.copiedLotId, lot);
    await this.repositories?.copiedLots.put(lot.copiedLotId, lot, { actorId: settings.followerAgentId });
    await this.persistAction({
      actionLedgerId: `copied-lot-opened:${lot.copiedLotId}`,
      kind: "COPIED_LOT_OPENED",
      sourceAgentId: settings.sourceAgentId,
      followerAgentId: settings.followerAgentId,
      copySettingsId: settings.copySettingsId,
      copiedLotId: lot.copiedLotId,
      payload: lot as unknown as Record<string, unknown>,
      createdAt: lot.openedAt,
    });
    return { ...lot };
  }
}

export function agentWalletExportWarning(): {
  warning: string;
  requiredCheckbox: string;
} {
  return {
    warning: [
      "This is your agent wallet private key.",
      "DNA x402 cannot recover it.",
      "Anyone with this key can move your funds.",
      "Save it somewhere safe.",
      "Do not share it.",
      "DNA x402 never stores this key.",
    ].join("\n"),
    requiredCheckbox: "I understand DNA x402 cannot recover this key.",
  };
}

export function copySettingsFingerprint(settings: CopySettings): string {
  return stableHash({
    copySettingsId: settings.copySettingsId,
    followerAgentId: settings.followerAgentId,
    sourceAgentId: settings.sourceAgentId,
    mode: settings.mode,
    copyBuys: settings.copyBuys,
    copySells: settings.copySells,
    copyExits: settings.copyExits,
    minEntryPriceBps: settings.minEntryPriceBps,
    maxEntryPriceBps: settings.maxEntryPriceBps,
    maxBetSizeAtomic: settings.maxBetSizeAtomic,
    maxDailySpendAtomic: settings.maxDailySpendAtomic,
    maxOpenExposureAtomic: settings.maxOpenExposureAtomic,
    customTakeProfitBps: settings.customTakeProfitBps,
    customStopLossBps: settings.customStopLossBps,
  });
}
