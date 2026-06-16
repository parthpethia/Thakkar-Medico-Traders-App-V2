const INDIAN_MOBILE = /^[6-9]\d{9}$/;

export function isValidIndianMobile(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  const normalized = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return INDIAN_MOBILE.test(normalized);
}

export function normalizeIndianMobile(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  return digits.slice(0, 10);
}
