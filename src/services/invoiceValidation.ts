import { supabase } from './supabase';
import type { ExtractedInvoice } from './invoiceExtraction';

export interface ValidationLog {
  field_name: string;
  extracted_value: string;
  matched_value: string;
  validation_result: 'match' | 'warning' | 'error';
  notes: string;
}

export interface MatchedCustomerResult {
  customer: any | null;
  confidence: number;
  warnings: string[];
}

export interface MatchedProductResult {
  product: any | null;
  confidence: number;
  warnings: string[];
}

export interface InvoiceValidationResult {
  customerMatch: MatchedCustomerResult;
  productMatches: Array<{
    itemIndex: number;
    extractedItem: any;
    matchedProduct: any | null;
    confidence: number;
    warnings: string[];
  }>;
  mathValidation: {
    subtotal: number;
    gst_total: number;
    discount_total: number;
    round_off: number;
    grand_total: number;
    mismatches: string[];
    isMathValid: boolean;
  };
  validationLogs: ValidationLog[];
  overallStatus: 'success' | 'warning' | 'failed';
  isDuplicate: boolean;
  duplicateOrderId?: string;
}

export type MatchedInvoiceResult = InvoiceValidationResult;

/**
 * Alias for validateInvoice, matching Phase 3 plan specification.
 */
export const matchExtractedInvoice = validateInvoice;



/**
 * Standard Levenshtein distance calculation for fuzzy matching.
 */
function getLevenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1].toLowerCase() === s2[j - 1].toLowerCase()) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1, // deletion
          dp[i][j - 1] + 1, // insertion
          dp[i - 1][j - 1] + 1 // substitution
        );
      }
    }
  }
  return dp[m][n];
}

/**
 * Normalizes text to compare names while ignoring spacing/punctuation.
 */
function normalizeString(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Computes string similarity between 0 and 1.
 */
export function getStringSimilarity(s1: string, s2: string): number {
  const n1 = normalizeString(s1);
  const n2 = normalizeString(s2);
  if (!n1 || !n2) return 0;
  if (n1 === n2) return 1.0;

  const distance = getLevenshteinDistance(n1, n2);
  const maxLength = Math.max(n1.length, n2.length);
  return 1.0 - distance / maxLength;
}

/**
 * Finds customer in database using matching priorities.
 */
export async function validateCustomer(party: ExtractedInvoice['party']): Promise<MatchedCustomerResult> {
  const warnings: string[] = [];

  // Priority 1: Match by Party Code
  if (party.code) {
    const { data } = await supabase
      .from('profiles')
      .select('id, name, business_name, phone, address, city, state, pincode, approved, role, retailer_code, gstin')
      .eq('retailer_code', party.code)
      .eq('role', 'retailer')
      .limit(1)
      .maybeSingle();

    if (data) {
      if (!data.approved) {
        warnings.push('Matched customer is not approved');
      }
      return { customer: data, confidence: 1.0, warnings };
    }
  }

  // Priority 2: Match by GSTIN (Exact or Fuzzy Levenshtein similarity >= 0.85)
  if (party.gst) {
    const normalizedGst = party.gst.toUpperCase().trim();
    const { data: exactGst } = await supabase
      .from('profiles')
      .select('id, name, business_name, phone, address, city, state, pincode, approved, role, retailer_code, gstin')
      .eq('gstin', normalizedGst)
      .eq('role', 'retailer')
      .limit(1)
      .maybeSingle();

    if (exactGst) {
      if (!exactGst.approved) {
        warnings.push('Matched customer is not approved');
      }
      return { customer: exactGst, confidence: 0.95, warnings };
    }

    // Fuzzy GSTIN search (small edit-distance tolerance for 1-2 character OCR misreads)
    const { data: gstCandidates } = await supabase
      .from('profiles')
      .select('id, name, business_name, phone, address, city, state, pincode, approved, role, retailer_code, gstin')
      .not('gstin', 'is', null)
      .eq('role', 'retailer')
      .limit(100);

    if (gstCandidates && gstCandidates.length > 0) {
      for (const cand of gstCandidates) {
        if (cand.gstin) {
          const candGst = cand.gstin.toUpperCase().trim();
          const similarity = getStringSimilarity(normalizedGst, candGst);
          if (similarity >= 0.85) {
            if (!cand.approved) {
              warnings.push('Matched customer is not approved');
            }
            warnings.push(`Matched GSTIN with minor OCR discrepancy (${normalizedGst} vs ${candGst})`);
            return { customer: cand, confidence: 0.92, warnings };
          }
        }
      }
    }
  }

  // Priority 3: Match by Exact Name (Business or Person)
  if (party.name) {
    const { data: exactMatch } = await supabase
      .from('profiles')
      .select('id, name, business_name, phone, address, city, state, pincode, approved, role, retailer_code, gstin')
      .or(`business_name.eq.${party.name},name.eq.${party.name}`)
      .eq('role', 'retailer')
      .limit(1)
      .maybeSingle();

    if (exactMatch) {
      if (!exactMatch.approved) {
        warnings.push('Matched customer is not approved');
      }
      return { customer: exactMatch, confidence: 0.9, warnings };
    }
  }

  // Priority 4 & 5: Normalized / Fuzzy match
  // Fetch candidate list (first 50 approved/unapproved retailers) to match fuzzy
  const { data: candidates } = await supabase
    .from('profiles')
    .select('id, name, business_name, phone, address, city, state, pincode, approved, role, retailer_code, gstin')
    .eq('role', 'retailer')
    .limit(100);

  if (candidates && candidates.length > 0 && party.name) {
    let bestMatch: any = null;
    let maxSimilarity = 0;

    for (const cand of candidates) {
      const simBusiness = getStringSimilarity(party.name, cand.business_name || '');
      const simName = getStringSimilarity(party.name, cand.name || '');
      const currentMax = Math.max(simBusiness, simName);

      if (currentMax > maxSimilarity) {
        maxSimilarity = currentMax;
        bestMatch = cand;
      }
    }

    // Similarity threshold of 0.65 for fuzzy matching
    if (maxSimilarity >= 0.65 && bestMatch) {
      warnings.push(`Fuzzy match with ${(maxSimilarity * 100).toFixed(0)}% similarity. Business name: ${bestMatch.business_name}`);
      if (!bestMatch.approved) {
        warnings.push('Matched customer is not approved');
      }
      return { customer: bestMatch, confidence: Number(maxSimilarity.toFixed(2)), warnings };
    }
  }

  return { customer: null, confidence: 0, warnings: ['No customer match found'] };
}

/**
 * Finds a single product in database using matching priorities.
 */
export async function validateProduct(item: ExtractedInvoice['items'][0]): Promise<MatchedProductResult> {
  const warnings: string[] = [];

  // Priority 1: Match by Product Code / SKU
  if (item.product_code) {
    const { data } = await supabase
      .from('products')
      .select('id, name, sku, mrp, selling_price, gst_percent, stock_quantity, is_active, pack_size')
      .eq('sku', item.product_code)
      .limit(1)
      .maybeSingle();

    if (data) {
      return compareProductDetails(item, data, 1.0);
    }
  }

  // Priority 2: Match by Exact Name
  if (item.product_name) {
    const { data } = await supabase
      .from('products')
      .select('id, name, sku, mrp, selling_price, gst_percent, stock_quantity, is_active, pack_size')
      .eq('name', item.product_name)
      .limit(1)
      .maybeSingle();

    if (data) {
      return compareProductDetails(item, data, 0.95);
    }
  }

  // Priority 3 & 4: Normalized & Fuzzy Match
  // Fetch up to 150 active products to scan fuzzy
  const { data: candidates } = await supabase
    .from('products')
    .select('id, name, sku, mrp, selling_price, gst_percent, stock_quantity, is_active, pack_size')
    .eq('is_active', true)
    .limit(150);

  if (candidates && candidates.length > 0 && item.product_name) {
    let bestMatch: any = null;
    let maxSimilarity = 0;

    for (const cand of candidates) {
      const similarity = getStringSimilarity(item.product_name, cand.name);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        bestMatch = cand;
      }
    }

    if (maxSimilarity >= 0.6 && bestMatch) {
      return compareProductDetails(item, bestMatch, Number(maxSimilarity.toFixed(2)));
    }
  }

  return { product: null, confidence: 0, warnings: ['No matching product found in database'] };
}

/**
 * Compares details between extracted items and matched DB products.
 */
function compareProductDetails(extracted: ExtractedInvoice['items'][0], dbProd: any, baseConfidence: number): MatchedProductResult {
  const warnings: string[] = [];

  if (!dbProd.is_active) {
    warnings.push('Product is marked as inactive in database');
  }

  // Stock check
  if (dbProd.stock_quantity < extracted.quantity) {
    warnings.push(`Insufficient stock: Requested ${extracted.quantity}, available ${dbProd.stock_quantity}`);
  }

  // Selling Price check
  if (extracted.rate !== dbProd.selling_price) {
    warnings.push(`Price mismatch: Extracted ₹${extracted.rate.toFixed(2)}, DB ₹${dbProd.selling_price.toFixed(2)}`);
  }

  // GST Percent check
  if (extracted.gst !== dbProd.gst_percent) {
    warnings.push(`GST mismatch: Extracted ${extracted.gst}%, DB ${dbProd.gst_percent}%`);
  }

  // Expiry / Batch tracking could add warnings if desired in future
  return { product: dbProd, confidence: baseConfidence, warnings };
}

/**
 * Recalculates line items and invoice mathematical totals.
 */
export function validateInvoiceMath(invoice: ExtractedInvoice): InvoiceValidationResult['mathValidation'] {
  const mismatches: string[] = [];
  let calculatedSubtotal = 0;
  let calculatedGstTotal = 0;

  invoice.items.forEach((item, index) => {
    // Math: Quantity * Rate
    const lineSubtotal = item.quantity * item.rate;
    const lineDiscount = item.discount || 0;
    const netLineSubtotal = Math.max(0, lineSubtotal - lineDiscount);

    calculatedSubtotal += netLineSubtotal;

    // Line GST
    const lineGst = (netLineSubtotal * item.gst) / 100;
    calculatedGstTotal += lineGst;

    // Check row item amount math
    const expectedAmount = Math.round((netLineSubtotal + lineGst) * 100) / 100;
    if (Math.abs(item.amount - expectedAmount) > 1.0) {
      mismatches.push(`Item #${index + 1} (${item.product_name}): Extracted amount ₹${item.amount.toFixed(2)} does not match calculated rate+gst of ₹${expectedAmount.toFixed(2)}`);
    }
  });

  calculatedSubtotal = Math.round(calculatedSubtotal * 100) / 100;
  calculatedGstTotal = Math.round(calculatedGstTotal * 100) / 100;

  const discountTotal = invoice.totals.discount_total || 0;
  const rawGrandTotal = calculatedSubtotal + calculatedGstTotal - discountTotal;
  const calculatedGrandTotal = Math.round((rawGrandTotal + (invoice.totals.round_off || 0)) * 100) / 100;

  // Comparison
  if (Math.abs(calculatedSubtotal - invoice.totals.subtotal) > 1.0) {
    mismatches.push(`Subtotal mismatch: Calculated ₹${calculatedSubtotal.toFixed(2)}, Extracted ₹${invoice.totals.subtotal.toFixed(2)}`);
  }
  if (Math.abs(calculatedGstTotal - invoice.totals.gst_total) > 1.0) {
    mismatches.push(`GST mismatch: Calculated ₹${calculatedGstTotal.toFixed(2)}, Extracted ₹${invoice.totals.gst_total.toFixed(2)}`);
  }
  if (Math.abs(calculatedGrandTotal - invoice.totals.grand_total) > 1.0) {
    mismatches.push(`Grand total mismatch: Calculated ₹${calculatedGrandTotal.toFixed(2)}, Extracted ₹${invoice.totals.grand_total.toFixed(2)}`);
  }

  return {
    subtotal: calculatedSubtotal,
    gst_total: calculatedGstTotal,
    discount_total: discountTotal,
    round_off: invoice.totals.round_off || 0,
    grand_total: calculatedGrandTotal,
    mismatches,
    isMathValid: mismatches.length === 0,
  };
}

/**
 * Scans database to detect if a similar invoice was already imported for the retailer.
 * Checks both completed invoice_uploads and existing orders table notes.
 */
export async function checkForDuplicateInvoice(retailerId: string, invoiceNumber: string): Promise<{ isDuplicate: boolean; orderId?: string }> {
  if (!retailerId || !invoiceNumber || !invoiceNumber.trim()) {
    return { isDuplicate: false };
  }

  const cleanInvNum = invoiceNumber.trim();

  // 1. Indexed lookup on orders table: Scoped strictly per-retailer (user_id)
  const { data: indexedOrderMatch } = await supabase
    .from('orders')
    .select('id')
    .eq('user_id', retailerId)
    .eq('invoice_number', cleanInvNum)
    .limit(1)
    .maybeSingle();

  if (indexedOrderMatch) {
    return { isDuplicate: true, orderId: indexedOrderMatch.id };
  }

  // Fallback check on notes for orders created prior to index migration
  const { data: orderMatches } = await supabase
    .from('orders')
    .select('id, notes')
    .eq('user_id', retailerId)
    .ilike('notes', `%${cleanInvNum}%`)
    .limit(1)
    .maybeSingle();

  if (orderMatches) {
    return { isDuplicate: true, orderId: orderMatches.id };
  }

  // 2. Query completed invoice uploads with this same invoice number and customer
  const { data, error } = await supabase
    .from('invoice_uploads')
    .select(`
      id,
      linked_order_id,
      invoice_extractions (
        parsed_json,
        edited_json
      )
    `)
    .eq('processing_status', 'completed')
    .not('linked_order_id', 'is', null);

  if (error || !data) {
    return { isDuplicate: false };
  }

  for (const upload of data) {
    const extractions = Array.isArray(upload.invoice_extractions)
      ? upload.invoice_extractions
      : [upload.invoice_extractions];

    for (const ext of extractions) {
      if (!ext) continue;
      const json = ext.edited_json || ext.parsed_json;
      if (!json) continue;

      const extInvNum = json.invoice?.number;

      if (extInvNum && extInvNum.trim().toLowerCase() === cleanInvNum.toLowerCase()) {
        const { data: orderData } = await supabase
          .from('orders')
          .select('user_id')
          .eq('id', upload.linked_order_id)
          .maybeSingle();

        if (orderData && orderData.user_id === retailerId) {
          return { isDuplicate: true, orderId: upload.linked_order_id || undefined };
        }
      }
    }
  }

  return { isDuplicate: false };
}

/**
 * Runs complete validation chain.
 */
export async function validateInvoice(invoice: ExtractedInvoice): Promise<InvoiceValidationResult> {
  const logs: ValidationLog[] = [];
  let overallStatus: 'success' | 'warning' | 'failed' = 'success';

  // 1. Customer
  const customerResult = await validateCustomer(invoice.party);
  if (!customerResult.customer) {
    overallStatus = 'failed';
    logs.push({
      field_name: 'party.name',
      extracted_value: invoice.party.name,
      matched_value: '',
      validation_result: 'error',
      notes: 'No customer match found in profiles',
    });
  } else {
    if (customerResult.warnings.length > 0) {
      if ((overallStatus as string) !== 'failed') overallStatus = 'warning';
      customerResult.warnings.forEach(w => {
        logs.push({
          field_name: 'party.name',
          extracted_value: invoice.party.name,
          matched_value: customerResult.customer.business_name || customerResult.customer.name,
          validation_result: 'warning',
          notes: w,
        });
      });
    } else {
      logs.push({
        field_name: 'party.name',
        extracted_value: invoice.party.name,
        matched_value: customerResult.customer.business_name || customerResult.customer.name,
        validation_result: 'match',
        notes: 'Customer matched successfully',
      });
    }
  }

  // 2. Check Duplicate
  let isDuplicate = false;
  let duplicateOrderId: string | undefined;

  if (customerResult.customer && invoice.invoice.number) {
    const dupCheck = await checkForDuplicateInvoice(customerResult.customer.id, invoice.invoice.number);
    isDuplicate = dupCheck.isDuplicate;
    duplicateOrderId = dupCheck.orderId;

    if (isDuplicate) {
      overallStatus = 'failed';
      logs.push({
        field_name: 'invoice.number',
        extracted_value: invoice.invoice.number,
        matched_value: '',
        validation_result: 'error',
        notes: `Duplicate invoice detected: Already imported for order ID: ${duplicateOrderId}`,
      });
    }
  }

  // 3. Products
  const productMatches: InvoiceValidationResult['productMatches'] = [];
  for (let i = 0; i < invoice.items.length; i++) {
    const item = invoice.items[i];
    const match = await validateProduct(item);

    productMatches.push({
      itemIndex: i,
      extractedItem: item,
      matchedProduct: match.product,
      confidence: match.confidence,
      warnings: match.warnings,
    });

    if (!match.product) {
      overallStatus = 'failed';
      logs.push({
        field_name: `items[${i}].product_name`,
        extracted_value: item.product_name,
        matched_value: '',
        validation_result: 'error',
        notes: `Unmatched product: ${item.product_name}`,
      });
    } else {
      if (match.warnings.length > 0) {
        if (overallStatus !== 'failed') overallStatus = 'warning';
        match.warnings.forEach(w => {
          logs.push({
            field_name: `items[${i}].product_name`,
            extracted_value: item.product_name,
            matched_value: match.product.name,
            validation_result: 'warning',
            notes: w,
          });
        });
      } else {
        logs.push({
          field_name: `items[${i}].product_name`,
          extracted_value: item.product_name,
          matched_value: match.product.name,
          validation_result: 'match',
          notes: 'Product matched successfully',
        });
      }
    }
  }

  // 4. Totals Recalculation
  const mathValidation = validateInvoiceMath(invoice);
  if (!mathValidation.isMathValid) {
    if (overallStatus !== 'failed') overallStatus = 'warning';
    mathValidation.mismatches.forEach(m => {
      logs.push({
        field_name: 'totals',
        extracted_value: `Sub: ${invoice.totals.subtotal}, Grand: ${invoice.totals.grand_total}`,
        matched_value: `Sub: ${mathValidation.subtotal}, Grand: ${mathValidation.grand_total}`,
        validation_result: 'warning',
        notes: m,
      });
    });
  }

  return {
    customerMatch: customerResult,
    productMatches,
    mathValidation,
    validationLogs: logs,
    overallStatus,
    isDuplicate,
    duplicateOrderId,
  };
}
