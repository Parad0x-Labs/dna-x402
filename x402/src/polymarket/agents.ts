import { assertBackendRelayOnly } from "./security.js";

export interface AgentRiskSettings {
  maxTradeSizePusd: number;
  maxDailySpendPusd: number;
  maxDailyLossPusd: number;
  maxMarketExposurePusd: number;
  maxOpenOrders: number;
  maxSlippageBps: number;
  categoryBlacklist: string[];
  dryRun: boolean;
  manualApprovalMode: boolean;
}

export interface AgentProfile {
  id: string;
  immutableSlug: string;
  displayName: string;
  ownerSolanaAddress: string;
  ownerEvmAddress: string;
  depositWallet: string;
  defaultWithdrawalRecipient: string;
  emergencyWithdrawalRecipient?: string;
  emergencyWithdrawalAuditLogId?: string;
  riskSettings: AgentRiskSettings;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_AGENT_RISK_SETTINGS: AgentRiskSettings = {
  maxTradeSizePusd: 25,
  maxDailySpendPusd: 250,
  maxDailyLossPusd: 50,
  maxMarketExposurePusd: 100,
  maxOpenOrders: 10,
  maxSlippageBps: 100,
  categoryBlacklist: [],
  dryRun: true,
  manualApprovalMode: true,
};

export function cleanAgentSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
}

export class AgentProfileStore {
  private readonly profiles = new Map<string, AgentProfile>();
  private readonly slugToId = new Map<string, string>();

  create(input: {
    id: string;
    displayName: string;
    ownerSolanaAddress: string;
    ownerEvmAddress: string;
    depositWallet: string;
    riskSettings?: Partial<AgentRiskSettings>;
    now?: Date;
    payloadForCustodyScan?: unknown;
  }): AgentProfile {
    assertBackendRelayOnly(input.payloadForCustodyScan ?? input);
    const immutableSlug = cleanAgentSlug(input.displayName);
    if (!immutableSlug) {
      throw new Error("Agent name must produce a stable public slug.");
    }
    if (this.slugToId.has(immutableSlug)) {
      throw new Error(`Agent slug already exists: ${immutableSlug}`);
    }
    const now = input.now ?? new Date();
    const profile: AgentProfile = {
      id: input.id,
      immutableSlug,
      displayName: input.displayName,
      ownerSolanaAddress: input.ownerSolanaAddress,
      ownerEvmAddress: input.ownerEvmAddress,
      depositWallet: input.depositWallet,
      defaultWithdrawalRecipient: input.ownerSolanaAddress,
      riskSettings: {
        ...DEFAULT_AGENT_RISK_SETTINGS,
        ...input.riskSettings,
        categoryBlacklist: input.riskSettings?.categoryBlacklist ?? DEFAULT_AGENT_RISK_SETTINGS.categoryBlacklist,
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.profiles.set(profile.id, profile);
    this.slugToId.set(profile.immutableSlug, profile.id);
    return profile;
  }

  get(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  getBySlug(slug: string): AgentProfile | undefined {
    const id = this.slugToId.get(cleanAgentSlug(slug));
    return id ? this.profiles.get(id) : undefined;
  }

  updateRiskSettings(id: string, patch: Partial<AgentRiskSettings>, now = new Date()): AgentProfile {
    assertBackendRelayOnly(patch);
    const profile = this.requireProfile(id);
    const updated = {
      ...profile,
      riskSettings: {
        ...profile.riskSettings,
        ...patch,
        categoryBlacklist: patch.categoryBlacklist ?? profile.riskSettings.categoryBlacklist,
      },
      updatedAt: now.toISOString(),
    };
    this.profiles.set(id, updated);
    return updated;
  }

  rename(): never {
    throw new Error("Agent names are immutable because public pages and copy-ledger IDs depend on stable slugs.");
  }

  setEmergencyWithdrawalRecipient(input: {
    id: string;
    recipientAddress: string;
    adminApproved: boolean;
    adminAuditLogId?: string;
    reason?: string;
    now?: Date;
  }): AgentProfile {
    assertBackendRelayOnly(input);
    if (!input.adminApproved || !input.adminAuditLogId || !input.reason) {
      throw new Error("Emergency withdrawal recipient changes require admin approval, reason, and audit log id.");
    }
    const profile = this.requireProfile(input.id);
    const updated = {
      ...profile,
      emergencyWithdrawalRecipient: input.recipientAddress,
      emergencyWithdrawalAuditLogId: input.adminAuditLogId,
      updatedAt: (input.now ?? new Date()).toISOString(),
    };
    this.profiles.set(profile.id, updated);
    return updated;
  }

  private requireProfile(id: string): AgentProfile {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new Error(`Agent profile not found: ${id}`);
    }
    return profile;
  }
}
