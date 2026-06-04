/** Normalize Indian mobile input to E.164 for Supabase Auth */
export function formatPhoneE164(phone: string): string {
  if (phone.startsWith('+')) {
    return phone.replace(/\s/g, '');
  }
  const digits = phone.replace(/\D/g, '');
  return '+91' + digits;
}
