export type DemoMode = "transfer" | "netting" | "stream";

export interface DemoResource {
  path: string;
  amountAtomic: string;
  description: string;
  response: Record<string, unknown>;
}

export const DEMO_RESOURCES: DemoResource[] = [
  {
    path: "/resource",
    amountAtomic: "1000",
    description: "Fixed-price resource lookup",
    response: {
      ok: true,
      kind: "resource",
      result: "demo resource payload",
    },
  },
  {
    path: "/inference",
    amountAtomic: "5000",
    description: "Paid inference call",
    response: {
      ok: true,
      kind: "inference",
      model: "dna-demo",
      result: "The answer is 42.",
      tokens: 847,
    },
  },
  {
    path: "/stream-access",
    amountAtomic: "100",
    description: "Paid stream-style access gate",
    response: {
      ok: true,
      kind: "stream-access",
      access: "granted",
    },
  },
];

export function normalizeDemoMode(input?: string): DemoMode {
  if (input === "transfer" || input === "netting" || input === "stream") {
    return input;
  }
  return "transfer";
}

export function demoProofValue(mode: DemoMode, quoteId: string): string {
  return `demo-${mode}-${quoteId}`;
}
