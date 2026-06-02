/**
 * @parad0x_labs/null-marketplace
 *
 * The .null task marketplace SDK.
 * Post tasks. Pay in NULL. Get proof-anchored deliverables.
 * Every completed task = WorkProof anchored on Solana.
 */

import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

export interface TaskListing {
  taskId: string;
  title: string;
  description: string;
  requiredCapabilities: string[]; // e.g. ['coding', 'research', 'image']
  bountyNull: number;             // NULL credits offered
  bountyUsdc?: number;            // optional USDC bonus
  deadline: number;               // unix timestamp
  posterAddress: string;          // .null domain or Solana wallet
  attachmentHash?: string;        // Arweave tx ID with task details
  status: 'open' | 'assigned' | 'completed' | 'paid';
}

export interface TaskBid {
  bidId: string;
  taskId: string;
  bidderAddress: string;    // bidder's .null domain or wallet
  proposedApproach: string; // 280 chars max
  estimatedTime: number;    // minutes
  creditsRequested: number; // NULL credits
  workProofHash?: string;   // prior proof-of-work hash if available
}

export interface TaskAssignment {
  taskId: string;
  bidId: string;
  assignedAt: number; // unix timestamp
  bidderAddress: string;
  escrowHash: string;
}

export interface Deliverable {
  taskId: string;
  resultArweaveTx: string;
  workProofHash: string;
  submittedAt: number; // unix timestamp
}

export interface WorkProof {
  version: number;
  taskId: string;
  bidderAddress: string;
  resultArweaveTx: string;
  workProofHash: string;
  completedAt: number;   // unix timestamp
  bountyNull: number;
  bountyUsdc: number;
  solanaAnchorSlot: number; // slot where proof was anchored (mock)
}

// ---------------------------------------------------------------------------
// Bounty complexity tiers
// ---------------------------------------------------------------------------

export type TaskComplexity = 'simple' | 'medium' | 'complex' | 'expert';

export interface BountyEstimate {
  suggestedNull: number;
  suggestedUsdc: number;
  estimatedMinutes: number;
}

const COMPLEXITY_TIERS: Record<TaskComplexity, BountyEstimate> = {
  simple:  { suggestedNull: 10,   suggestedUsdc: 0.5,  estimatedMinutes: 5    },
  medium:  { suggestedNull: 50,   suggestedUsdc: 5,    estimatedMinutes: 30   },
  complex: { suggestedNull: 200,  suggestedUsdc: 20,   estimatedMinutes: 120  },
  expert:  { suggestedNull: 1000, suggestedUsdc: 100,  estimatedMinutes: 1440 },
};

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Build a new TaskListing. The task is created in 'open' status.
 */
export function buildTaskListing(params: {
  title: string;
  description: string;
  requiredCapabilities: string[];
  bountyNull: number;
  bountyUsdc?: number;
  deadline: number;
  posterAddress: string;
  attachmentHash?: string;
}): TaskListing {
  return {
    taskId: randomUUID(),
    title: params.title,
    description: params.description,
    requiredCapabilities: params.requiredCapabilities,
    bountyNull: params.bountyNull,
    bountyUsdc: params.bountyUsdc,
    deadline: params.deadline,
    posterAddress: params.posterAddress,
    attachmentHash: params.attachmentHash,
    status: 'open',
  };
}

/**
 * Build a TaskBid from a mesh node. Approach is capped at 280 characters.
 */
export function buildBid(
  taskId: string,
  bidder: string,
  approach: string,
  credits: number,
  opts?: { estimatedTime?: number; workProofHash?: string }
): TaskBid {
  const trimmedApproach = approach.slice(0, 280);
  return {
    bidId: randomUUID(),
    taskId,
    bidderAddress: bidder,
    proposedApproach: trimmedApproach,
    estimatedTime: opts?.estimatedTime ?? 30,
    creditsRequested: credits,
    workProofHash: opts?.workProofHash,
  };
}

/**
 * Accept a bid on a task. Transitions the task to 'assigned' and returns
 * an assignment record plus a mock escrow hash.
 *
 * In production, escrowHash is the Solana transaction signature that locks
 * the NULL bounty in escrow until deliverable release.
 */
export function acceptBid(
  task: TaskListing,
  bid: TaskBid
): { assignment: TaskAssignment; escrowHash: string } {
  if (task.status !== 'open') {
    throw new Error(`Task ${task.taskId} is not open (current status: ${task.status})`);
  }
  if (bid.taskId !== task.taskId) {
    throw new Error(`Bid ${bid.bidId} does not reference task ${task.taskId}`);
  }

  const escrowHash = deriveEscrowHash(task.taskId, bid.bidId);

  const assignment: TaskAssignment = {
    taskId: task.taskId,
    bidId: bid.bidId,
    assignedAt: Math.floor(Date.now() / 1000),
    bidderAddress: bid.bidderAddress,
    escrowHash,
  };

  // Mutate task status in-place (caller holds the reference)
  task.status = 'assigned';

  return { assignment, escrowHash };
}

/**
 * Submit a completed deliverable for a task.
 * Returns a receipt that records the Arweave tx and work-proof hash.
 */
export function submitDeliverable(
  taskId: string,
  resultArweaveTx: string,
  workProofHash: string
): { receipt: Deliverable } {
  const receipt: Deliverable = {
    taskId,
    resultArweaveTx,
    workProofHash,
    submittedAt: Math.floor(Date.now() / 1000),
  };
  return { receipt };
}

/**
 * Release payment for a completed task.
 * Transitions the task to 'paid', generates a WorkProof anchored on Solana,
 * and returns the mock payment transaction signature.
 *
 * In production, paymentTx is the Solana signature that releases escrow and
 * mints the WorkProof NFT / on-chain record.
 */
export function releasePayment(
  task: TaskListing,
  deliverable: Deliverable
): { paymentTx: string; workProof: WorkProof } {
  if (task.status !== 'assigned' && task.status !== 'completed') {
    throw new Error(
      `Task ${task.taskId} must be assigned or completed to release payment (current: ${task.status})`
    );
  }
  if (deliverable.taskId !== task.taskId) {
    throw new Error(`Deliverable taskId mismatch: expected ${task.taskId}`);
  }

  const completedAt = Math.floor(Date.now() / 1000);
  const paymentTx = derivePaymentTx(task.taskId, deliverable.workProofHash, completedAt);

  const workProof: WorkProof = {
    version: 1,
    taskId: task.taskId,
    bidderAddress: '', // set by caller who holds the assignment
    resultArweaveTx: deliverable.resultArweaveTx,
    workProofHash: deliverable.workProofHash,
    completedAt,
    bountyNull: task.bountyNull,
    bountyUsdc: task.bountyUsdc ?? 0,
    solanaAnchorSlot: mockSolanaSlot(),
  };

  task.status = 'paid';

  return { paymentTx, workProof };
}

/**
 * Estimate bounty for a given task complexity tier.
 */
export function estimateBounty(taskComplexity: TaskComplexity): BountyEstimate {
  return { ...COMPLEXITY_TIERS[taskComplexity] };
}

// ---------------------------------------------------------------------------
// Internal helpers (deterministic mocks — replace with real Solana calls)
// ---------------------------------------------------------------------------

function deriveEscrowHash(taskId: string, bidId: string): string {
  // In production: Solana escrow PDA address derived from task + bid seeds
  return `escrow_${taskId.slice(0, 8)}_${bidId.slice(0, 8)}`;
}

function derivePaymentTx(taskId: string, workProofHash: string, ts: number): string {
  // In production: Solana tx signature from escrow release instruction
  return `paytx_${taskId.slice(0, 8)}_${workProofHash.slice(0, 8)}_${ts}`;
}

function mockSolanaSlot(): number {
  // Approximate current Solana mainnet slot (increases ~2/sec)
  // Replace with `connection.getSlot()` in production
  const GENESIS_EPOCH_TS = 1609459200; // 2021-01-01 00:00:00 UTC
  const now = Math.floor(Date.now() / 1000);
  return Math.floor((now - GENESIS_EPOCH_TS) * 2);
}
