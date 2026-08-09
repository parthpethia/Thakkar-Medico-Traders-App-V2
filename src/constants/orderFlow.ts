import { OrderStatus } from '../types';

/** Admin overflow menu + DB trigger alignment (UX only; trigger is authoritative). */
export const VALID_NEXT_STATUSES: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['pending', 'cancelled'],
  pending: ['assigned', 'rejected', 'cancelled'],
  assigned: ['accepted', 'rejected', 'cancelled'],
  accepted: ['picked_up', 'cancelled'],
  approved: ['packed', 'cancelled', 'assigned'],
  packed: ['assigned', 'cancelled'],
  picked_up: ['dispatched', 'cancelled'],
  dispatched: ['delivery_failed'],
  out_for_delivery: ['delivered', 'delivery_failed'],
  in_transit: ['delivered', 'delivery_failed'],
  arriving_soon: ['delivered', 'delivery_failed'],
  processing: ['approved', 'packed', 'cancelled'],
  delivered: [],
  cancelled: [],
  rejected: [],
  payment_failed: ['pending_payment'],
  delivery_failed: ['assigned', 'cancelled'],
};

export function getAdminOverflowStatuses(
  status: OrderStatus,
  paymentMode?: string,
): OrderStatus[] {
  let options = VALID_NEXT_STATUSES[status] ?? [];
  if (status === 'pending_payment' && paymentMode === 'upi') {
    options = options.filter((s) => s !== 'pending');
  }
  return options;
}

/** Driver-facing primary action per order status (delivery fulfillment). */
export type DriverAction =
  | 'accept'
  | 'reject'
  | 'mark_picked_up'
  | 'mark_dispatched'
  | 'mark_delivered'
  | 'report_failed'
  | 'none';

export function driverActionForStatus(
  status: OrderStatus,
  fulfillmentMode?: string,
): DriverAction {
  const isPickup = fulfillmentMode === 'pickup';
  switch (status) {
    case 'assigned':
      return 'accept';
    case 'accepted':
      return 'mark_picked_up';
    case 'picked_up':
      return 'mark_dispatched';
    case 'packed':
      return isPickup ? 'mark_dispatched' : 'none';
    case 'dispatched':
      return 'mark_delivered';
    default:
      return 'none';
  }
}

/**
 * Secondary driver action — shown alongside the primary action.
 * Currently only used to offer "Can't Deliver" on dispatched orders.
 */
export function driverSecondaryActionForStatus(
  status: OrderStatus,
): DriverAction | null {
  if (status === 'dispatched') return 'report_failed';
  return null;
}

/** Sort priority for run sheet (lower = sooner). */
export function runSheetPriority(status: OrderStatus): number {
  switch (status) {
    case 'assigned':
      return 0;
    case 'accepted':
      return 1;
    case 'picked_up':
      return 2;
    case 'dispatched':
      return 3;
    case 'packed':
      return 4;
    case 'delivery_failed':
      return 5;
    default:
      return 50;
  }
}

/** Delivery failure reasons — labels for the UI picker. */
export const DELIVERY_FAILURE_REASONS = [
  { value: 'shop_closed', label: 'Shop closed' },
  { value: 'retailer_unreachable', label: 'Retailer unreachable' },
  { value: 'wrong_address', label: 'Wrong address' },
  { value: 'refused_delivery', label: 'Refused delivery' },
  { value: 'partial_delivery', label: 'Partial delivery' },
  { value: 'damaged_goods', label: 'Damaged goods' },
  { value: 'expired_products', label: 'Expired products' },
  { value: 'payment_dispute', label: 'Payment dispute' },
  { value: 'other', label: 'Other' },
] as const;

export type DeliveryFailureReason = typeof DELIVERY_FAILURE_REASONS[number]['value'];

/** Return reasons — labels for the UI picker. */
export const RETURN_REASONS = [
  { value: 'damaged', label: 'Damaged' },
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'rejected', label: 'Rejected by retailer' },
  { value: 'expired', label: 'Expired' },
  { value: 'other', label: 'Other' },
] as const;

export type ReturnReason = typeof RETURN_REASONS[number]['value'];

/** Return resolution options for admin. */
export const RETURN_RESOLUTIONS = [
  { value: 'refund', label: 'Refund' },
  { value: 'replace', label: 'Replace' },
  { value: 'credit_note', label: 'Credit note' },
] as const;
