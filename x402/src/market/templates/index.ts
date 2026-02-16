import { ShopManifest } from "../types.js";
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
  return {
    manifestVersion: "market-v1",
    shopId: template.shopId,
    name: template.name,
    description: template.description,
    category: template.category,
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
