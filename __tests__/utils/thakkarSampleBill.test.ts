import { normalizeExtractedInvoice } from '../../src/services/invoiceExtraction';
import { validateInvoiceMath } from '../../src/services/invoiceValidation';
import type { ExtractedInvoice } from '../../src/types/invoice';

describe('Thakkar Medico Sample Bill Shape Integration Test', () => {
  it('validates Thakkar Medico bill with bill-level discount and CGST/SGST split', () => {
    const rawThakkarBill = {
      readability_score: 0.92,
      image_quality_notes: 'Clear image, slight crease near party address',
      is_multi_page: false,
      is_truncated: false,
      party: {
        code: 'NIRMAL01',
        name: 'M/s NIRMAL PLUS PHARMACY',
        gst: '24AAAAA0000A1Z5',
        address: 'Shop 4, Nirmal Complex, Ahmedabad',
      },
      invoice: {
        number: 'TM-2026-8841',
        date: '2026-08-01',
      },
      items: [
        {
          product_name: 'DOLO 650 TABLET 15S',
          product_code: 'DOLO650',
          batch: 'B2409',
          expiry: '2027-12',
          quantity: 10,
          free_quantity: 1,
          rate: 25.5,
          discount: 0,
          gst: 12, // 6% CGST + 6% SGST
          amount: 285.6, // (10 * 25.5 = 255) + 12% GST (30.6) = 285.6
        },
      ],
      totals: {
        subtotal: 255.0,
        gst_total: 30.6,
        discount_total: 15.0, // Bill-level scheme discount
        round_off: 0.0,
        grand_total: 270.6, // 255.0 + 30.6 - 15.0 = 270.6
      },
    };

    const normalized: ExtractedInvoice = normalizeExtractedInvoice(rawThakkarBill);

    expect(normalized.party.name).toBe('M/s NIRMAL PLUS PHARMACY');
    expect(normalized.party.code).toBe('NIRMAL01');
    expect(normalized.invoice.number).toBe('TM-2026-8841');
    expect(normalized.items).toHaveLength(1);
    expect(normalized.items[0].quantity).toBe(10);
    expect(normalized.items[0].free_quantity).toBe(1);

    const mathResult = validateInvoiceMath(normalized);

    expect(mathResult.subtotal).toBe(255.0);
    expect(mathResult.gst_total).toBe(30.6);
    expect(mathResult.discount_total).toBe(15.0);
    expect(mathResult.grand_total).toBe(270.6);
    expect(mathResult.isMathValid).toBe(true);
    expect(mathResult.mismatches).toHaveLength(0);
  });

  it('verifies items with null product_code (HSN 3004 omitted) do not collide and fall through to name matching', () => {
    const rawMultiItemHsnBill = {
      readability_score: 0.95,
      image_quality_notes: null,
      is_multi_page: false,
      is_truncated: false,
      party: {
        code: null,
        name: 'M/s NIRMAL PLUS PHARMACY',
        gst: '27AAMCD7494F1ZA',
        address: 'BUILDING NO.C-2 NIRMAL NAGRI',
      },
      invoice: {
        number: 'A004467',
        date: '07-07-2026',
      },
      items: [
        {
          product_name: 'SOLECROSS LOTION 50 50GM',
          product_code: null, // Omitted HSN 3004
          batch: 'WEB1032',
          expiry: '7/27',
          quantity: 10,
          free_quantity: 0,
          rate: 355.47,
          discount: 1184.78,
          gst: 18.0,
          amount: 3554.70,
        },
        {
          product_name: 'CROCIN 650MG TABLET',
          product_code: null, // Omitted HSN 3004
          batch: 'CR991',
          expiry: '9/28',
          quantity: 5,
          free_quantity: 0,
          rate: 30.0,
          discount: 0,
          gst: 12.0,
          amount: 150.0,
        },
      ],
      totals: {
        subtotal: 3704.70,
        gst_total: 444.58,
        discount_total: 1184.78,
        round_off: 0.50,
        grand_total: 2965.00,
      },
    };

    const normalized = normalizeExtractedInvoice(rawMultiItemHsnBill);
    expect(normalized.items[0].product_code || null).toBeNull();
    expect(normalized.items[1].product_code || null).toBeNull();
    expect(normalized.items[0].product_name).not.toEqual(normalized.items[1].product_name);
  });
});
