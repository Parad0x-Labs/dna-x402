"use client";

// Wallet/RPC-driven page — force dynamic, no SSG. The screen reads the connected
// wallet's owned .null names live from mainnet, so static prerendering is both
// pointless and the source of the known Node-22 prerender crash; opt out of SSG.
export const dynamic = "force-dynamic";

import { Sell } from "@/components/Sell";

export default function SellPage() {
  return <Sell />;
}
