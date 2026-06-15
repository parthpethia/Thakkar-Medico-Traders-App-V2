/** Normalize PostgREST / fetch errors (message is often empty). */
export function supabaseErrorMessage(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const e = err as {
    message?: string;
    details?: string;
    code?: string;
    hint?: string;
  };
  const parts = [e.message, e.details, e.hint, e.code].filter(
    (p) => p !== undefined && p !== null && String(p).trim() !== '',
  );
  if (parts.length > 0) return parts.join(' ');
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** True for timeouts / aborted fetches — safe to retry, do not clear session. */
export function isTransientNetworkError(err: unknown): boolean {
  if (!err) return false;
  const name = String((err as { name?: string }).name || '');
  const message = supabaseErrorMessage(err);
  const lower = message.toLowerCase();

  if (name === 'AbortError') return true;
  if (message === 'Aborted' || lower.includes('aborted')) return true;
  if (lower.includes('timed out') || lower.includes('timeout')) return true;
  if (lower.includes('network request failed')) return true;
  if (lower.includes('unable to reach supabase')) return true;
  if (lower.includes('error code: 522') || /\b522\b/.test(message)) return true;
  if (/\b(502|503|504|520|521|524)\b/.test(message)) return true;
  if (lower.includes('connection timed out') || lower.includes('cloudflare')) return true;

  return false;
}
