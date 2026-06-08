/**
 * null-miner-sdk
 *
 * Universal NULL Miner SDK — plug into any app, users earn USDC autonomously,
 * platform collects fees, we take tx dust.
 *
 * To our knowledge, the first known open-source Solana stack to COMBINE
 * x402 + Groth16 private settlement + Agent Passport. Built on DNA x402 + Dark NULL.
 *
 * Quick start:
 *   import { NullMiner } from "null-miner-sdk";
 *   const miner = new NullMiner({ rpcUrl, hostWallet, platformId });
 *   await miner.start();  // agent earns autonomously from here
 *
 * Platform adapters:
 *   import { nullMinerMiddleware } from "null-miner-sdk/nextjs";   // Shyft-style
 *   import { nullMinerGate }       from "null-miner-sdk/express";  // any REST API
 *   import { nullMinerPlugin }     from "null-miner-sdk/openclaw"; // Momo-style
 */

// Core
export { NullMiner }           from "./core/NullMiner.js";
export { AgentPassport }       from "./core/Passport.js";
export { AgentLoop }           from "./core/AgentLoop.js";

// DNA x402 Payment Rail Surface
export {
  createPaymentRequirement,
  verifyPaymentHeader,
  anchorReceiptPayload,
  platformFeeSplit,
  usdcToAtomic,
  atomicToUsdc,
  USDC_MAINNET,
  USDC_DEVNET,
  NULL_TOKEN,
  X402_VERSION,
  MEMO_PREFIX,
} from "./x402/index.js";
export type {
  X402PaymentRequirements,
  VerifiedPayment,
  RejectedPayment,
  PaymentVerifyResult,
  FeeSplit,
  ReceiptAnchorPayload,
  PassportX402Meta,
  CreatePaymentRequirementOpts,
  SolanaNetwork,
} from "./x402/index.js";

// Task Registry + Executors
export {
  TaskRegistry,
  ResidentialRelayExecutor,
  AppStoreSnapshotExecutor,
  LocationAttestationExecutor,
  ProtocolMaintenanceExecutor,
} from "./tasks/TaskRegistry.js";

// Types
export type {
  NullMinerConfig,
  HostWallet,
  TaskSpec,
  TaskKind,
  TaskProof,
  TaskResult,
  MinerStats,
  PassportConfig,
  PassportAttestation,
  ContentGateOptions,
  PlatformFeeConfig,
  ProofRequirements,
  ReputationTier,
} from "./core/types.js";

export { TaskKind as TaskKindEnum, ReputationTier as ReputationTierEnum } from "./core/types.js";

// ZK primitives — BN254 Poseidon, Semaphore identity, SnarkPack receipts
// Full API: import { poseidonHash2, generateIdentity, buildReceiptWitness } from "null-miner-sdk/zk"
export {
  BN254_FIELD_P,
  fieldMod,
  bytesToField,
  fieldToBytes,
  hexToField,
  fieldToHex,
  poseidonHash2,
  poseidonHashHex,
  poseidonMerkleHash,
  sha256Field,
} from "./zk/poseidon.js";
export {
  generateIdentity,
  deriveIdentityFromKey,
  reconstructIdentity,
  computeIdentityCommitment,
  computeNullifierHash,
  buildExternalNullifier,
  IncrementalMerkleTree,
  buildSignalWitness,
  computeZeroHashes,
  SEMAPHORE_TREE_DEPTH,
  ZERO_LEAF,
} from "./zk/semaphore.js";
export {
  buildReceiptWitness,
  computeReceiptPublicInputs,
  buildSnarkPackBatch,
  merkleRootPoseidon,
} from "./zk/receipt.js";
export type {
  SemaphoreIdentity,
  MerkleProof,
  SemaphoreSignalWitness,
} from "./zk/semaphore.js";
export type {
  ReceiptWitness,
  ReceiptPublicInputs,
  SnarkPackBatch,
} from "./zk/receipt.js";

// Privacy primitives — DKSAP stealth, Dark Pool encryption, NULL Mint blind sigs
// Full API: import { generateStealthAddress, encryptTask, clientBlind } from "null-miner-sdk/privacy"
export {
  generateStealthKeyPair,
  deriveStealthKeyPair,
  generateStealthAddress,
  checkStealthAddress,
  recoverStealthSpendKey,
} from "./privacy/stealth.js";
export {
  encryptTask,
  decryptTask,
  sealBid,
  openBid,
} from "./privacy/darkPool.js";
export {
  mintKeyGen,
  mintSignInit,
  mintSign,
  clientBlind,
  clientUnblind,
  verifyNullToken,
} from "./privacy/nullMint.js";
export type {
  StealthKeyPair,
  StealthAddress,
  StealthSpendKey,
} from "./privacy/stealth.js";
export type {
  EncryptedTask,
  SealedBid,
} from "./privacy/darkPool.js";
export type {
  MintKeyPair,
  MintNonce,
  BlindedChallenge,
  BlindingState,
  BlindSignatureResponse,
  UnblindedToken,
} from "./privacy/nullMint.js";

// Version
export const SDK_VERSION      = "0.1.0";
export const NULL_MINT        = "8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump";
export const IS_MAINNET_READY = false; // devnet only until audit

export const TASK_MARKETPLACE_URL = "https://marketplace.devnet.solana.com"; // devnet
// production: https://marketplace.null-miner.xyz  (post-audit)

export * from "./vault/index.js";

// NULL Miner Loop
export { runNullMinerTaskLoop, createMockEncryptedTask, TaskLoopSimulator } from "./tasks/NullMinerLoop.js";
export type { TaskLoopConfig, TaskLoopResult, TaskLoopStep, EncryptedTaskPayload } from "./tasks/NullMinerLoop.js";

// Liquefy Bridge
export { createNullArchive, bridgeArchiveToAnchor, scanArchiveForAgent, mergeArchives } from "./liquefy/bridge.js";
export type { NullArchive, NullArchiveEntry, ArchiveBridgeResult } from "./liquefy/bridge.js";

// NULL Flywheel
export { NullFlywheel, computeNullYield, buildMintAuthorizationHash } from "./flywheel/index.js";
export type { FlywheelConfig, FlywheelYield, EpochStats } from "./flywheel/index.js";

// Identity
export {
  createEthAgentAuthMessage,
  formatEthPersonalSignMessage,
  ethPersonalSignHash,
  parseEthSignature,
  recoverEthAddress,
  deriveAgentAuthPda,
  buildSecp256k1AuthInstruction,
} from "./identity/metamask.js";
export type { EthAgentAuthMessage, EthSignatureComponents, AgentAuthPda } from "./identity/metamask.js";

// Spectre Passport v2
export { AgentPassportV2, PassportTier, upgradePassportTier, computePassportId } from "./core/PassportV2.js";
export type { PassportV2Config, PassportV2Attestation } from "./core/PassportV2.js";

// Coalitions
export { createCoalition, buildCoalitionSignal, verifyCoalitionThreshold, addCoalitionMember } from "./coalitions/index.js";
export type { GuildCoalition, CoalitionMember, CoalitionSignal } from "./coalitions/index.js";

// NULL Lottery
export { buildCommitment, revealDraw, verifyDraw, checkWin as checkLotteryWin, generateSeed, buildFallbackWinnerIndex } from "./lottery/DrawMachine.js";
export { createTicket, batchTicketsToArchive, buildFallbackPool, findFallbackWinner, checkBatchForWin, buildBatchRoot } from "./lottery/TicketStore.js";
export { buyTicket, commitDraw, submitRoundTickets, revealAndDraw, executeFallbackDraw, computeJackpot, buildClaimReceipt, DEFAULT_LOTTERY_CONFIG } from "./lottery/LotterySDK.js";
export type { LotteryTicket, TicketBatch, FallbackPool } from "./lottery/TicketStore.js";
export type { LotteryConfig, RoundInfo, BuyTicketResult, RoundDrawResult, FallbackDrawResult } from "./lottery/LotterySDK.js";
export type { DrawResult, DrawVerification } from "./lottery/DrawMachine.js";

// Deployment profiles
export {
  OSS_PROFILE,
  COMMERCIAL_PROFILE,
  setProfile,
  getProfile,
  isCommercial,
  isNullEmissionActive,
  profileFingerprint,
  lotteryConfigFromProfile,
  flywheelConfigFromProfile,
} from "./config/profiles.js";
export type { NullMinerProfile, NetworkTrack, ProgramIds } from "./config/profiles.js";
