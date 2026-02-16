import { ShopEndpoint } from "../types.js";

export interface McpToolImport {
  serverName: string;
  tools: Array<{
    name: string;
    description?: string;
    tags?: string[];
  }>;
}

export function importMcpTools(input: McpToolImport): ShopEndpoint[] {
  return input.tools.map((tool) => ({
    endpointId: `mcp-${tool.name.replace(/[^a-zA-Z0-9_]+/g, "-")}`,
    method: "POST",
    path: `/mcp/${tool.name}`,
    capabilityTags: tool.tags && tool.tags.length > 0 ? tool.tags : ["mcp_tool"],
    description: tool.description ?? `MCP tool ${tool.name}`,
    pricingModel: {
      kind: "flat",
      amountAtomic: "1000",
    },
    settlementModes: ["transfer", "stream", "netting"],
    sla: {
      maxLatencyMs: 1500,
      availabilityTarget: 0.99,
    },
    examples: [
      `curl -X POST https://api.example.com/mcp/${tool.name}`,
    ],
  }));
}
