import { afterEach, describe, expect, it } from "vitest";
import { runDemoBuyer } from "../src/demo/buyer.js";
import { DemoMode } from "../src/demo/shared.js";
import { StartedDemoSeller, startDemoSeller } from "../src/demo/seller.js";

const startedServers: StartedDemoSeller[] = [];

afterEach(async () => {
  while (startedServers.length > 0) {
    const current = startedServers.pop();
    if (current) {
      await current.close();
    }
  }
});

describe("demo buyer/seller flow", () => {
  for (const mode of ["transfer", "netting", "stream"] as DemoMode[]) {
    it(`runs end-to-end in ${mode} mode`, async () => {
      const seller = await startDemoSeller({
        mode,
        port: 0,
        quiet: true,
      });
      startedServers.push(seller);

      const result = await runDemoBuyer({
        baseUrl: seller.baseUrl,
        mode,
        quiet: true,
      });

      expect(result.receiptCount).toBe(6);
      expect(result.results).toHaveLength(3);
      expect(result.results.every((entry) => entry.status === 200)).toBe(true);
      expect(result.results.every((entry) => typeof entry.receiptId === "string" && entry.receiptId.length > 0)).toBe(true);
    }, 15000);
  }
});
