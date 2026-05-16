import { stableHash } from "../common/stable.js";
import { parseAtomic } from "../feePolicy.js";

export interface CapacityReservation {
  reservationId: string;
  buyerId: string;
  sellerId: string;
  capacityUnits: number;
  paidHold: boolean;
  expiresAt: string;
}

export function reservationLocksCapacity(reservation: CapacityReservation, now = new Date()): boolean {
  if (new Date(reservation.expiresAt).getTime() <= now.getTime()) {
    return false;
  }
  return reservation.paidHold;
}

export function enforceOutstandingCommitLimit(commits: Array<{ buyerId: string; paid: boolean; expiresAt: string }>, buyerId: string, maxOutstanding: number, now = new Date()): void {
  const outstanding = commits.filter((commit) =>
    commit.buyerId === buyerId
    && !commit.paid
    && new Date(commit.expiresAt).getTime() > now.getTime());
  if (outstanding.length >= maxOutstanding) {
    throw new Error("outstanding unpaid commit limit exceeded");
  }
}

export interface VolumeEdge {
  buyerWallet: string;
  sellerWallet: string;
  amountAtomic: string;
  fundingClusterId?: string;
}

export function trustedExternalVolume(edges: VolumeEdge[]): string {
  const trusted = edges.filter((edge) => {
    if (edge.buyerWallet === edge.sellerWallet) {
      return false;
    }
    if (edge.fundingClusterId && edge.fundingClusterId === stableHash([edge.buyerWallet, edge.sellerWallet].sort())) {
      return false;
    }
    return true;
  });
  return trusted.reduce((sum, edge) => sum + parseAtomic(edge.amountAtomic), 0n).toString(10);
}

export interface SealedBidCommit {
  bidderId: string;
  commitmentHash: string;
}

export function sealedBidHash(params: { bidderId: string; amountAtomic: string; salt: string }): string {
  return stableHash(params);
}

export function verifySealedBidReveal(commit: SealedBidCommit, reveal: { bidderId: string; amountAtomic: string; salt: string }): void {
  if (commit.bidderId !== reveal.bidderId || commit.commitmentHash !== sealedBidHash(reveal)) {
    throw new Error("sealed bid reveal does not match commitment");
  }
}

export interface BundleDependency {
  from: string;
  to: string;
}

export function assertNoBundleCycle(edges: BundleDependency[], maxDepth: number): void {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge.to]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(node: string, depth: number): void {
    if (depth > maxDepth) {
      throw new Error("bundle max depth exceeded");
    }
    if (visiting.has(node)) {
      throw new Error("bundle circular dependency detected");
    }
    if (visited.has(node)) {
      return;
    }
    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      dfs(next, depth + 1);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) {
    dfs(node, 0);
  }
}
