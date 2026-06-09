"use client";

// Wallet/RPC-driven page — force dynamic, no SSG (dodges the Node-22 prerender
// crash and is correct anyway since the content depends on the user's wallet).
export const dynamic = "force-dynamic";

import { MyNames } from "@/components/MyNames";

export default function MyNamesPage() {
  return <MyNames />;
}
