import { describe, expect, it } from 'vitest';
import { SAFE_TEMPLATES } from '../src/components/ShopWizard';
import { isSafeCategory, requiresUnverifiedConfirm } from '../src/lib/marketSafety';

describe('wallet market safety', () => {
  it('wizard templates are safe-category only', () => {
    expect(SAFE_TEMPLATES.length).toBeGreaterThan(0);
    for (const template of SAFE_TEMPLATES) {
      expect(isSafeCategory(template.category)).toBe(true);
    }
  });

  it('requires warning confirm for unverified or flagged shops', () => {
    expect(requiresUnverifiedConfirm({
      verifiable: { receipt: true, anchored: false },
      trust: { score: 88, report_count: 0, warning: false },
    })).toBe(true);

    expect(requiresUnverifiedConfirm({
      verifiable: { receipt: true, anchored: true },
      trust: { score: 45, report_count: 0, warning: true },
    })).toBe(true);

    expect(requiresUnverifiedConfirm({
      verifiable: { receipt: true, anchored: true },
      trust: { score: 90, report_count: 2, warning: false },
    })).toBe(true);

    expect(requiresUnverifiedConfirm({
      verifiable: { receipt: true, anchored: true },
      trust: { score: 95, report_count: 0, warning: false },
    })).toBe(false);
  });
});
