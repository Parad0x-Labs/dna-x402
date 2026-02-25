import { SafeCategory, ShopManifest } from "../types.js";
import { actionPack } from "./action.js";
import { alwaysOnPack } from "./alwaysOn.js";
import { opsPack } from "./ops.js";
import { researchPack } from "./research.js";

function toShopManifest(template: {
  shopId: string;
  name: string;
  description: string;
  category: string;
  endpoint: ShopManifest["endpoints"][number];
}, ownerPubkey: string): ShopManifest {
  const normalized = template.category.trim().toLowerCase();
  const categoryByTemplate: Record<string, SafeCategory> = {
    research: "data_enrichment",
    ops: "workflow_tool",
    action: "workflow_tool",
    actions: "workflow_tool",
    stream: "ai_inference",
    ai_inference: "ai_inference",
    image_generation: "image_generation",
    data_enrichment: "data_enrichment",
    workflow_tool: "workflow_tool",
  };

  return {
    manifestVersion: "market-v1",
    shopId: template.shopId,
    name: template.name,
    description: template.description,
    category: categoryByTemplate[normalized] ?? "workflow_tool",
    ownerPubkey,
    endpoints: [template.endpoint],
  };
}

export function createReferenceShops(ownerPubkey: string): ShopManifest[] {
  const templates = [...researchPack, ...opsPack, ...actionPack, ...alwaysOnPack];
  return templates.map((template) => toShopManifest(template, ownerPubkey));
}

export function countReferenceSkus(): number {
  return [...researchPack, ...opsPack, ...actionPack, ...alwaysOnPack].length;
}
