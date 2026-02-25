export type SafeCategory = 'ai_inference' | 'image_generation' | 'data_enrichment' | 'workflow_tool';

export const SAFE_CATEGORY_SET: ReadonlySet<SafeCategory> = new Set([
  'ai_inference',
  'image_generation',
  'data_enrichment',
  'workflow_tool',
]);

export interface WarningQuote {
  verifiable?: {
    receipt: boolean;
    anchored: boolean;
  };
  trust?: {
    score: number;
    report_count: number;
    warning: boolean;
  };
}

export function isSafeCategory(value: string): value is SafeCategory {
  return SAFE_CATEGORY_SET.has(value as SafeCategory);
}

export function requiresUnverifiedConfirm(quote: WarningQuote): boolean {
  return (quote.verifiable?.anchored !== true)
    || Boolean(quote.trust?.warning)
    || (quote.trust?.report_count ?? 0) > 0;
}
