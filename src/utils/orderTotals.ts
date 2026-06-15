/**
 * Shared order-total computation used across checkout, cart, delivery, and admin screens.
 *
 * The server (place_order RPC) is the authoritative source of totals for placed orders.
 * This utility exists only for *display* purposes so the user sees a preview before
 * confirming. It must stay in sync with the server-side formula.
 */

export interface TotalsLineItem {
  selling_price: number;
  quantity: number;
  gst_percent: number;
}

export interface OrderTotalsOptions {
  /** Flat discount amount to subtract from grand total */
  discountAmount?: number;
  /** Loyalty points the user wants to redeem */
  loyaltyPoints?: number;
  /** ₹ value per loyalty point (e.g. 0.5) */
  loyaltyRate?: number;
  /** Max percentage of order value that can be redeemed via loyalty */
  maxRedemptionPercent?: number;
}

export interface OrderTotals {
  subtotal: number;
  gst: number;
  grandTotal: number;
  /** Loyalty points deduction in ₹ (capped at maxRedemptionPercent of subtotal+gst) */
  loyaltyDeduction: number;
}

export function computeOrderTotals(
  items: TotalsLineItem[],
  gstEnabled: boolean,
  options?: OrderTotalsOptions,
): OrderTotals {
  let subtotal = 0;
  let gst = 0;

  for (const item of items) {
    const lineSubtotal = item.selling_price * item.quantity;
    subtotal += lineSubtotal;

    if (gstEnabled) {
      gst += (lineSubtotal * item.gst_percent) / 100;
    }
  }

  subtotal = Math.round(subtotal * 100) / 100;
  gst = Math.round(gst * 100) / 100;

  let grandTotal = Math.round((subtotal + gst) * 100) / 100;

  // Apply flat discount
  const discount = options?.discountAmount ?? 0;
  if (discount > 0) {
    grandTotal = Math.round((grandTotal - discount) * 100) / 100;
  }

  // Apply loyalty deduction
  let loyaltyDeduction = 0;
  const { loyaltyPoints = 0, loyaltyRate = 0, maxRedemptionPercent = 100 } = options ?? {};
  if (loyaltyPoints > 0 && loyaltyRate > 0) {
    const rawDeduction = loyaltyPoints * loyaltyRate;
    const maxDeduction = (grandTotal * maxRedemptionPercent) / 100;
    loyaltyDeduction = Math.round(Math.min(rawDeduction, maxDeduction) * 100) / 100;
    grandTotal = Math.round((grandTotal - loyaltyDeduction) * 100) / 100;
  }

  return {
    subtotal,
    gst,
    grandTotal: Math.max(grandTotal, 0),
    loyaltyDeduction,
  };
}
