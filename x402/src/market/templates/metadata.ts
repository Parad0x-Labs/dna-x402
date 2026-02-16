import { ShopManifest } from "../types.js";

export interface TemplateSku {
  shopId: string;
  name: string;
  description: string;
  category: string;
  endpoint: ShopManifest["endpoints"][number];
}

export const SKU_ICONS: Record<string, string> = {
  web_search_with_citations: "search",
  pdf_fetch_extract: "file-text",
  summarize_with_quotes: "quote",
  classify_fast: "bolt",
  dedupe_normalize: "layers",
  entity_extract: "scan",
  send_email_stub: "mail",
  calendar_book_stub: "calendar",
  form_fill_stub: "form",
  tool_gateway_stream_access: "radio",
};

export function exampleCurl(method: "GET" | "POST", path: string): string {
  return `curl -X ${method} https://api.darknull.market${path}`;
}
