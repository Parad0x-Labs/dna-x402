import { exampleCurl, SKU_ICONS, TemplateSku } from "./metadata.js";

export const alwaysOnPack: TemplateSku[] = [
  {
    shopId: "always-on-gateway",
    name: "tool_gateway_stream_access",
    description: "Always-on streamed tool gateway",
    category: "always_on",
    endpoint: {
      endpointId: "tool_gateway_stream_access",
      method: "GET",
      path: "/stream-access",
      capabilityTags: ["tool_gateway_stream_access", "gateway", "stream"],
      description: "Streaming access to tool gateway",
      icon: SKU_ICONS.tool_gateway_stream_access,
      examples: [exampleCurl("GET", "/stream-access")],
      pricingModel: { kind: "stream", rateAtomicPerSecond: "10", minTopupAtomic: "600" },
      settlementModes: ["stream", "transfer", "netting"],
      sla: { maxLatencyMs: 450, availabilityTarget: 0.999 },
    },
  },
];
