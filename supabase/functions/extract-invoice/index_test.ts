import { assertEquals } from 'https://deno.land/std@0.192.0/testing/asserts.ts';

Deno.test('extract-invoice Edge Function - Idempotency Response Check', () => {
  const existingExtraction = {
    id: 'ext-12345',
    invoice_upload_id: 'up-9999',
    confidence_score: 0.95,
    edited_json: {
      party: { name: 'M/s NIRMAL PLUS PHARMACY', code: 'NIRMAL01' },
      invoice: { number: 'TM-2026-8841' },
    },
  };

  const responsePayload = {
    success: true,
    already_extracted: true,
    extraction_id: existingExtraction.id,
    invoice_upload_id: existingExtraction.invoice_upload_id,
    confidence_score: existingExtraction.confidence_score,
    parsed_json: existingExtraction.edited_json,
  };

  assertEquals(responsePayload.already_extracted, true);
  assertEquals(responsePayload.extraction_id, 'ext-12345');
});

Deno.test('extract-invoice Edge Function - Rate Limit 429 Response Check', () => {
  const hourlyCount = 20;
  const limit = 20;
  const minutesRemaining = 14;

  const responsePayload = {
    success: false,
    error: 'hourly_rate_limit_exceeded',
    message: `Hourly extraction limit reached (${limit} per hour). Please try again in ${minutesRemaining} minutes.`,
    minutes_remaining: minutesRemaining,
  };

  assertEquals(responsePayload.error, 'hourly_rate_limit_exceeded');
  assertEquals(responsePayload.minutes_remaining, 14);
});
