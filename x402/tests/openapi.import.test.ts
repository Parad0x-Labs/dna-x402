import { describe, expect, it } from "vitest";
import { importOpenApiSpec } from "../src/market/import/openapi.js";

describe("openapi importer", () => {
  it("imports GET/POST operations with descriptions and schemas", () => {
    const spec = {
      openapi: "3.1.0",
      info: {
        title: "Demo Seller API",
        description: "Sample OpenAPI for marketplace import",
      },
      paths: {
        "/search": {
          get: {
            summary: "Search corpus",
            tags: ["research", "search"],
            responses: {
              200: {
                description: "ok",
              },
            },
          },
        },
        "/summarize": {
          post: {
            description: "Summarize document",
            tags: ["summarize"],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      text: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "summary",
              },
            },
          },
          put: {
            // should be ignored by minimal importer
            summary: "Ignored",
          },
        },
      },
    };

    const imported = importOpenApiSpec(spec, {
      defaultLatencyMs: 1750,
      pricingModel: {
        kind: "flat",
        amountAtomic: "1234",
      },
    });

    expect(imported.title).toBe("Demo Seller API");
    expect(imported.description).toContain("Sample OpenAPI");
    expect(imported.endpoints).toHaveLength(2);

    const getSearch = imported.endpoints.find((endpoint) => endpoint.endpointId === "get-search");
    expect(getSearch).toBeDefined();
    expect(getSearch?.method).toBe("GET");
    expect(getSearch?.path).toBe("/search");
    expect(getSearch?.capabilityTags).toContain("research");
    expect(getSearch?.pricingModel.kind).toBe("flat");

    const postSummarize = imported.endpoints.find((endpoint) => endpoint.endpointId === "post-summarize");
    expect(postSummarize).toBeDefined();
    expect(postSummarize?.method).toBe("POST");
    expect(postSummarize?.requestSchema).toBeDefined();
    expect(postSummarize?.responseSchema).toBeDefined();
    expect(postSummarize?.sla.maxLatencyMs).toBe(1750);
  });
});

