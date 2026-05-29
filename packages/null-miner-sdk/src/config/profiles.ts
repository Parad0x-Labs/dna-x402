/**
 * null-miner-sdk - dual-track deployment profiles.
 *
 * OSS track: devnet, zero fees, zero NULL extraction, MIT license.
 * Commercial track: unaudited mainnet pilot, 0.5% house config,
 * 5% NULL emission accounting.
 *
 * Same codebase. One profile switch.
 */

import { createHash } from "crypto";

export type NetworkTrack = "oss" | "commercial";
export type SolanaNetwork = "devnet" | "mainnet-beta" | "localnet";

export interface ProgramIds {
  semaphore: string;
  vault: string;
  ethAuth: string;
  tokenHook: string;
  lottery: string;
  mintGate: string;
}

export interface NullMinerProfile {
  track: NetworkTrack;
  network: SolanaNetwork;
  description: string;

  // Fees: all zero in OSS, configured in commercial.
  houseFeeBps: number;
  nullEmissionPct: number;
  lotteryHouseFeeBps: number;
  lotteryTicketPriceNull: number;
  platformFeePct: number;

  // NULL emission limits.
  maxNullPerEpochAtomic: number;
  epochDurationSlots: number;

  // Program IDs after deployment.
  programs: ProgramIds;
  nullMint?: string;
  rpcUrl: string;
}

export const OSS_PROFILE: NullMinerProfile = {
  track: "oss",
  network: "devnet",
  description: "Open source devnet - zero fees, zero NULL extraction. MIT licensed.",
  houseFeeBps: 0,
  nullEmissionPct: 0,
  lotteryHouseFeeBps: 0,
  lotteryTicketPriceNull: 0,
  platformFeePct: 0,
  maxNullPerEpochAtomic: 0,
  epochDurationSlots: 432000,
  programs: {
    semaphore: "SEmBHKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    vault: "VAuLTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ethAuth: "ETHAuxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    tokenHook: "HooKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    lottery: "LoTTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    mintGate: "MiNTGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
  rpcUrl: "https://api.devnet.solana.com",
};

export const COMMERCIAL_PROFILE: NullMinerProfile = {
  track: "commercial",
  network: "mainnet-beta",
  description: "Unaudited commercial mainnet pilot - 0.5% house config, 5% NULL emission accounting.",
  houseFeeBps: 50,
  nullEmissionPct: 5,
  lotteryHouseFeeBps: 50,
  lotteryTicketPriceNull: 10_000_000,
  platformFeePct: 0,
  maxNullPerEpochAtomic: 1_000_000_000_000,
  epochDurationSlots: 432000,
  programs: {
    semaphore: "TODO_POST_DEPLOY",
    vault: "TODO_POST_DEPLOY",
    ethAuth: "TODO_POST_DEPLOY",
    tokenHook: "TODO_POST_DEPLOY",
    lottery: "TODO_POST_DEPLOY",
    mintGate: "TODO_POST_DEPLOY",
  },
  nullMint: "8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump",
  rpcUrl: "https://api.mainnet-beta.solana.com",
};

let activeProfile: NullMinerProfile = OSS_PROFILE;

/** Set the active profile for this process. Call once at startup. */
export function setProfile(profile: NullMinerProfile): void {
  activeProfile = profile;
}

/** Get the currently active profile. Defaults to OSS. */
export function getProfile(): NullMinerProfile {
  return activeProfile;
}

/** Convenience: is this the commercial mainnet track? */
export function isCommercial(): boolean {
  return activeProfile.track === "commercial";
}

/** Convenience: is NULL emission accounting active in the selected profile? */
export function isNullEmissionActive(): boolean {
  return activeProfile.nullEmissionPct > 0 && activeProfile.maxNullPerEpochAtomic > 0;
}

/**
 * Derive a profile fingerprint for logs and review.
 * fingerprint = SHA-256(track + network + houseFeeBps + nullEmissionPct)[:16]
 */
export function profileFingerprint(profile: NullMinerProfile): string {
  return createHash("sha256")
    .update(profile.track)
    .update(profile.network)
    .update(String(profile.houseFeeBps))
    .update(String(profile.nullEmissionPct))
    .digest("hex")
    .slice(0, 16);
}

/** Build a LotteryConfig-compatible object from the active profile. */
export function lotteryConfigFromProfile(profile?: NullMinerProfile): {
  ticketPriceNull: number;
  houseFeeBps: number;
  numbersCount: number;
  numbersRange: number;
  fallbackAfter: number;
  programId: string;
  isActive: boolean;
} {
  const p = profile ?? activeProfile;
  return {
    ticketPriceNull: p.lotteryTicketPriceNull,
    houseFeeBps: p.lotteryHouseFeeBps,
    numbersCount: 5,
    numbersRange: 30,
    fallbackAfter: 3,
    programId: p.programs.lottery,
    isActive: true,
  };
}

/** Build a FlywheelConfig-compatible object from the active profile. */
export function flywheelConfigFromProfile(profile?: NullMinerProfile): {
  emissionRatePct: number;
  maxNullPerEpoch: number;
  epochDurationSlots: number;
  mintGateProgramId: string;
} {
  const p = profile ?? activeProfile;
  return {
    emissionRatePct: p.nullEmissionPct,
    maxNullPerEpoch: p.maxNullPerEpochAtomic,
    epochDurationSlots: p.epochDurationSlots,
    mintGateProgramId: p.programs.mintGate,
  };
}
