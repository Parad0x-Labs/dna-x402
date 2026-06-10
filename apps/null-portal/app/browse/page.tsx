"use client";

// Wallet/RPC-driven page — force dynamic, no SSG (dodges the Node-22 prerender
// crash and is correct anyway since the listings are read live, cluster-aware,
// from Solana at request time).
export const dynamic = "force-dynamic";

import { Browse } from "@/components/Browse";

export default function BrowsePage() {
  return <Browse />;
}
