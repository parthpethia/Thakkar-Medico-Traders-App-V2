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
  dispatched: [],
  delivered: [],
  cancelled: [],
  rejected: [],
  payment_failed: ['pending_payment'],
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
    default:
      return 50;
  }
}
