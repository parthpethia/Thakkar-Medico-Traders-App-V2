type ErrLike = {
  message?: string;
  code?: string;
  status?: number;
  details?: string;
  hint?: string;
};

function combinedText(err: ErrLike): string {
  return [err.message, err.details, err.hint, err.code]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function mentionsEmail(text: string): boolean {
  return (
    /idx_profiles_email|profiles.*email|duplicate.*email|email.*already|already.*email|users_email|email_address/.test(
      text,
    ) || /\bemail\b/.test(text)
  );
}

function mentionsPhone(text: string): boolean {
  return (
    /idx_profiles_phone|profiles.*phone|duplicate.*phone|phone.*already|already.*phone/.test(
      text,
    ) || /\bphone\b/.test(text)
  );
}

function isDuplicateSignal(text: string): boolean {
  return (
    /duplicate key|unique constraint|23505|already registered|already been registered|user already exists|user_already_registered|signup_disabled|database error saving new user/.test(
      text,
    )
  );
}

/**
 * Maps Supabase Auth / Postgres trigger errors to retailer-friendly registration messages.
 */
export function mapRegistrationError(err: unknown): string {
  const e = (err ?? {}) as ErrLike;
  const text = combinedText(e);
  const raw = e.message?.trim() || 'Registration failed. Please try again.';

  if (e.code === 'user_already_registered' || /user already registered/i.test(raw)) {
    return 'This email address is already registered. Please sign in instead.';
  }

  if (!isDuplicateSignal(text) && !isDuplicateSignal(raw.toLowerCase())) {
    if (/invalid email|email address invalid/i.test(text)) {
      return 'Please enter a valid email address.';
    }
    if (/password/i.test(text) && /short|least|weak/i.test(text)) {
      return 'Password must be at least 6 characters.';
    }
    if (/network|fetch failed|timeout/i.test(text)) {
      return 'Network error. Check your connection and try again.';
    }
    return raw;
  }

  const emailHit = mentionsEmail(text);
  const phoneHit = mentionsPhone(text);

  if (emailHit && !phoneHit) {
    return 'This email address is already registered. Please sign in or use a different email.';
  }
  if (phoneHit && !emailHit) {
    return 'This phone number is already linked to another account. Use a different number or sign in.';
  }
  if (emailHit && phoneHit) {
    return 'This email or phone number is already registered. Please sign in or use different details.';
  }

  return 'An account with this email or phone number already exists. Please sign in or use different details.';
}
