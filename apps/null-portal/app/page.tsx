"use client";

// Force dynamic rendering: this page is entirely wallet/RPC-driven. Static
// prerendering it (Next 15 + Node 22) is both pointless and the source of the
// known Node-22 prerender crash, so we opt out of SSG here.
export const dynamic = "force-dynamic";

import { SearchRegister } from "@/components/SearchRegister";
import { Pitch } from "@/components/Pitch";
import { Proof } from "@/components/Proof";

export default function HomePage() {
  return (
    <>
      <SearchRegister />
      <Pitch />
      <Proof />
    </>
  );
}
