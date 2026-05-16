import { describe, expect, it } from "vitest";
import { createSellerApp } from "../src/index.js";

describe("seller paid API example", () => {
  it("creates an express app with DNA seller routes", () => {
    const app = createSellerApp();
    expect(typeof app).toBe("function");
  });
});
