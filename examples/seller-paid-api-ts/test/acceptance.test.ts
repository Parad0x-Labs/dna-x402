import { describe, expect, it } from "vitest";
import { createSellerApp } from "../src/index.js";

describe("seller paid API example", () => {
  it("creates an express app with DNA seller routes", () => {
    const app = createSellerApp();
    expect(typeof app).toBe("function");
  });

  it("answers the protected route with 402 Payment Required", async () => {
    const server = createSellerApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const { port } = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/api/summary`);
      expect(response.status).toBe(402);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
