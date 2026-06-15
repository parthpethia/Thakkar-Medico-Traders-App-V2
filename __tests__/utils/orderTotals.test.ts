import { computeOrderTotals } from '../../src/utils/orderTotals';

describe('computeOrderTotals', () => {
  const sampleItems = [
    { selling_price: 100, quantity: 2, gst_percent: 18 },
    { selling_price: 50, quantity: 3, gst_percent: 5 },
  ];

  it('computes subtotal correctly', () => {
    const result = computeOrderTotals(sampleItems, false);
    // 100*2 + 50*3 = 350
    expect(result.subtotal).toBe(350);
  });

  it('includes GST when enabled', () => {
    const result = computeOrderTotals(sampleItems, true);
    expect(result.subtotal).toBe(350);
    // GST: (200*0.18) + (150*0.05) = 36 + 7.5 = 43.5
    expect(result.gst).toBe(43.5);
    expect(result.grandTotal).toBe(393.5);
  });

  it('excludes GST when disabled', () => {
    const result = computeOrderTotals(sampleItems, false);
    expect(result.gst).toBe(0);
    expect(result.grandTotal).toBe(350);
  });

  it('handles empty items array', () => {
    const result = computeOrderTotals([], true);
    expect(result.subtotal).toBe(0);
    expect(result.gst).toBe(0);
    expect(result.grandTotal).toBe(0);
    expect(result.loyaltyDeduction).toBe(0);
  });

  it('handles single item with zero GST', () => {
    const items = [{ selling_price: 200, quantity: 1, gst_percent: 0 }];
    const result = computeOrderTotals(items, true);
    expect(result.subtotal).toBe(200);
    expect(result.gst).toBe(0);
    expect(result.grandTotal).toBe(200);
  });

  it('applies flat discount', () => {
    const result = computeOrderTotals(sampleItems, true, { discountAmount: 50 });
    // grandTotal = 393.5 - 50 = 343.5
    expect(result.grandTotal).toBe(343.5);
  });

  it('applies loyalty deduction', () => {
    const result = computeOrderTotals(sampleItems, true, {
      loyaltyPoints: 100,
      loyaltyRate: 0.5,
      maxRedemptionPercent: 100,
    });
    // loyalty = 100 * 0.5 = 50
    expect(result.loyaltyDeduction).toBe(50);
    expect(result.grandTotal).toBe(343.5); // 393.5 - 50
  });

  it('caps loyalty deduction at maxRedemptionPercent', () => {
    const result = computeOrderTotals(sampleItems, true, {
      loyaltyPoints: 10000,
      loyaltyRate: 1,
      maxRedemptionPercent: 10,
    });
    // Max deduction = 393.5 * 10% = 39.35
    expect(result.loyaltyDeduction).toBe(39.35);
    expect(result.grandTotal).toBe(354.15); // 393.5 - 39.35
  });

  it('grandTotal never goes below zero', () => {
    const items = [{ selling_price: 10, quantity: 1, gst_percent: 0 }];
    const result = computeOrderTotals(items, false, { discountAmount: 100 });
    expect(result.grandTotal).toBe(0);
  });

  it('backward-compatible: works without options', () => {
    const result = computeOrderTotals(sampleItems, true);
    expect(result.loyaltyDeduction).toBe(0);
    expect(result.grandTotal).toBe(393.5);
  });

  it('handles mixed GST rates correctly', () => {
    const items = [
      { selling_price: 100, quantity: 1, gst_percent: 0 },
      { selling_price: 100, quantity: 1, gst_percent: 5 },
      { selling_price: 100, quantity: 1, gst_percent: 12 },
      { selling_price: 100, quantity: 1, gst_percent: 18 },
      { selling_price: 100, quantity: 1, gst_percent: 28 },
    ];
    const result = computeOrderTotals(items, true);
    expect(result.subtotal).toBe(500);
    // GST: 0 + 5 + 12 + 18 + 28 = 63
    expect(result.gst).toBe(63);
    expect(result.grandTotal).toBe(563);
  });
});
