/** Normalize Indian mobile input to E.164 for Supabase Auth */
export function formatPhoneE164(phone: string): string {
  let cleaned = phone.replace(/\s/g, '');
  if (cleaned.startsWith('+91')) {
    return cleaned;
  }
  let digits = cleaned.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.substring(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  return '+91' + digits;
}
