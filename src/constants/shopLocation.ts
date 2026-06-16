import type { BranchLabel } from '../types/shopLocation';

export const BRANCH_LABEL_OPTIONS: {
  value: BranchLabel;
  emoji: string;
  label: string;
}[] = [
  { value: 'main_shop', emoji: '🏪', label: 'Main Shop' },
  { value: 'warehouse', emoji: '🏭', label: 'Warehouse' },
  { value: 'branch', emoji: '🏬', label: 'Branch' },
  { value: 'godown', emoji: '📦', label: 'Godown' },
  { value: 'custom', emoji: '✏️', label: 'Custom' },
];

export function branchDisplayLabel(
  branch: BranchLabel,
  customLabel?: string | null,
): string {
  if (branch === 'custom' && customLabel?.trim()) return customLabel.trim();
  return BRANCH_LABEL_OPTIONS.find((o) => o.value === branch)?.label ?? branch;
}

export function formatDeliveryWindow(start?: string | null, end?: string | null): string {
  if (!start && !end) return '';
  const fmt = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m || 0, 0, 0);
    return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  };
  if (start && end) return `${fmt(start)} – ${fmt(end)}`;
  if (start) return fmt(start);
  return end ? fmt(end) : '';
}

export function buildShortAddress(loc: {
  shop_no: string;
  building: string;
  area: string;
  city: string;
  pincode: string;
}): string {
  return [loc.shop_no, loc.building, loc.area, loc.city, loc.pincode]
    .filter(Boolean)
    .join(', ');
}

export function buildFullAddress(loc: {
  shop_no: string;
  building: string;
  street?: string | null;
  landmark: string;
  area: string;
  city: string;
  state: string;
  pincode: string;
}): string {
  const parts = [
    loc.shop_no,
    loc.building,
    loc.street,
    loc.landmark ? `Near ${loc.landmark}` : '',
    loc.area,
    loc.city,
    loc.state,
    loc.pincode,
  ].filter(Boolean);
  return parts.join(', ');
}
