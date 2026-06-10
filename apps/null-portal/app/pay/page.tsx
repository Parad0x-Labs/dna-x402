"use client";

// Force dynamic rendering: this page is entirely wallet/RPC-driven. Static
// prerendering it (Next 15 + Node 22) is both pointless and the source of the
// known Node-22 prerender crash, so we opt out of SSG here.
export const dynamic = "force-dynamic";

import { Pay } from "@/components/Pay";

export default function PayPage() {
  return <Pay />;
}
