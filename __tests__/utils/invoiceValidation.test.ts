import {
  cleanAndParseJson,
  normalizeExtractedInvoice,
  ManualJsonProvider,
} from '../../src/services/invoiceExtraction';
import {
  getStringSimilarity,
  validateInvoiceMath,
} from '../../src/services/invoiceValidation';

describe('Invoice Extraction & Validation Utils', () => {
  const validInvoiceJson = {
    party: {
      code: 'RET-001',
      name: 'Thakkar Retailers',
      gst: '27AAAAA1111A1Z1',
      address: 'Mumbai, Maharashtra',
    },
    invoice: {
      number: 'INV-2026-001',
      date: '2026-07-12',
    },
    items: [
      {
        product_name: 'Paracetamol 650mg',
        product_code: 'PARA650',
        batch: 'B123',
        expiry: '2028-12-31',
        quantity: 10,
        free_quantity: 1,
        rate: 20.0,
        discount: 10.0,
        gst: 12.0,
        amount: 212.8,
      },
      {
        product_name: 'Amoxicillin 500mg',
        product_code: 'AMOX500',
        batch: 'B456',
        expiry: '2027-06-30',
        quantity: 5,
        free_quantity: 0,
        rate: 80.0,
        discount: 0.0,
        gst: 18.0,
        amount: 472.0,
      },
    ],
    totals: {
      subtotal: 590.0,
      gst_total: 94.8,
      discount_total: 10.0,
      round_off: 0.2,
      grand_total: 675.0,
    },
  };

  describe('cleanAndParseJson', () => {
    it('parses correct JSON string directly', () => {
      const jsonStr = JSON.stringify(validInvoiceJson);
      const parsed = cleanAndParseJson(jsonStr);
      expect(parsed.party.code).toBe('RET-001');
    });

    it('strips markdown code blocks', () => {
      const rawText = `Here is the parsed invoice:
\`\`\`json
{
  "party": {
    "code": "RET-001"
  }
}
\`\`\`
Hope this helps!`;
      const parsed = cleanAndParseJson(rawText);
      expect(parsed.party.code).toBe('RET-001');
    });

    it('fixes trailing commas in arrays/objects', () => {
      const trailingCommaJson = `{
        "party": {
          "code": "RET-001",
        },
        "items": [
          {"name": "Item 1",},
        ],
      }`;
      const parsed = cleanAndParseJson(trailingCommaJson);
      expect(parsed.party.code).toBe('RET-001');
      expect(parsed.items[0].name).toBe('Item 1');
    });
  });

  describe('normalizeExtractedInvoice', () => {
    it('fills default fields for empty objects', () => {
      const normalized = normalizeExtractedInvoice({});
      expect(normalized.party.name).toBe('');
      expect(normalized.invoice.number).toBe('');
      expect(normalized.items).toEqual([]);
      expect(normalized.totals.grand_total).toBe(0);
    });

    it('normalizes type casting for rates and quantities', () => {
      const raw = {
        items: [
          {
            product_name: 'Test',
            quantity: '15',
            rate: '12.50',
          },
        ],
      };
      const normalized = normalizeExtractedInvoice(raw);
      expect(normalized.items[0].quantity).toBe(15);
      expect(normalized.items[0].rate).toBe(12.5);
    });
  });

  describe('getStringSimilarity', () => {
    it('returns 1.0 for identical strings case-insensitively', () => {
      expect(getStringSimilarity('Paracetamol 650mg', 'paracetamol 650mg')).toBe(1.0);
    });

    it('returns high similarity for minor differences', () => {
      const sim = getStringSimilarity('Paracetamol 650mg', 'Paracetaml 650 mg');
      expect(sim).toBeGreaterThan(0.8);
    });

    it('returns >= 0.85 similarity for 1-character GSTIN OCR misreads', () => {
      const originalGst = '27AAMCD7494F1ZA';
      const misreadGst = '27AAMCD7494F12A'; // 'Z' misread as '2'
      const sim = getStringSimilarity(originalGst, misreadGst);
      expect(sim).toBeGreaterThanOrEqual(0.85);
    });

    it('returns low similarity for unrelated strings', () => {
      const sim = getStringSimilarity('Paracetamol 650mg', 'Amoxicillin 500mg');
      expect(sim).toBeLessThan(0.4);
    });
  });

  describe('validateInvoiceMath', () => {
    it('successfully validates correct invoice math', () => {
      const normalized = normalizeExtractedInvoice(validInvoiceJson);
      const mathResult = validateInvoiceMath(normalized);
      expect(mathResult.isMathValid).toBe(true);
      expect(mathResult.grand_total).toBe(675.0);
    });

    it('flags math discrepancies for subtotal/gst/grand total mismatches', () => {
      const wrongInvoice = {
        ...validInvoiceJson,
        totals: {
          subtotal: 500.0, // actual: 590
          gst_total: 94.8,
          discount_total: 10.0,
          round_off: 0,
          grand_total: 900.0, // actual: 684.8
        },
      };
      const normalized = normalizeExtractedInvoice(wrongInvoice);
      const mathResult = validateInvoiceMath(normalized);
      expect(mathResult.isMathValid).toBe(false);
      expect(mathResult.mismatches.length).toBeGreaterThan(0);
      expect(mathResult.mismatches.some(m => m.includes('Subtotal mismatch'))).toBe(true);
      expect(mathResult.mismatches.some(m => m.includes('Grand total mismatch'))).toBe(true);
    });
  });
});
