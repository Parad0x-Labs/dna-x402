"use client";

// Force dynamic rendering: entirely wallet/RPC-driven (Next 15 + Node 22).
export const dynamic = "force-dynamic";

import { PrivateInbox } from "@/components/PrivateInbox";

export default function ReceivePage() {
  return <PrivateInbox />;
}
