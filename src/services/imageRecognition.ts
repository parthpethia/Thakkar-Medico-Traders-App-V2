import axios from 'axios';
import { supabase } from './supabase';
import { Product } from '../types';

const GOOGLE_VISION_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_VISION_API_KEY || '';
const VISION_API_URL = `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`;

/* ======================================================
   TYPES
====================================================== */

export interface ScanResult {
  extractedTexts: string[];     // raw text lines found in image
  matchedProducts: Product[];   // products matched from DB
  rawText: string;              // full raw text from OCR
}

/* ======================================================
   GOOGLE CLOUD VISION – TEXT DETECTION (OCR)
====================================================== */

/**
 * Send a base64-encoded image to Google Cloud Vision API
 * for TEXT_DETECTION (OCR). Returns the full extracted text.
 */
export async function extractTextFromImage(base64Image: string): Promise<string> {
  if (!GOOGLE_VISION_API_KEY) {
    throw new Error(
      'Google Vision API key is not configured. ' +
      'Add EXPO_PUBLIC_GOOGLE_VISION_API_KEY to your .env file.'
    );
  }

  const body = {
    requests: [
      {
        image: { content: base64Image },
        features: [
          { type: 'TEXT_DETECTION', maxResults: 10 },
        ],
      },
    ],
  };

  const response = await axios.post(VISION_API_URL, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000, // 15s timeout for Vision API
  });

  const annotations = response.data?.responses?.[0]?.textAnnotations;

  if (!annotations || annotations.length === 0) {
    return '';
  }

  // First annotation contains the full text block
  return annotations[0].description?.trim() || '';
}

/* ======================================================
   EXTRACT KEYWORDS FROM OCR TEXT
====================================================== */

const NOISE_WORDS = new Set([
  'mg', 'ml', 'gm', 'kg', 'tab', 'cap', 'inj', 'syp', 'strip', 'box',
  'pack', 'nos', 'tablets', 'capsules', 'injection', 'syrup', 'cream',
  'gel', 'ointment', 'drops', 'suspension', 'powder', 'sachet', 'vial',
  'mfg', 'mfd', 'exp', 'batch', 'lot', 'date', 'use', 'before',
  'net', 'qty', 'price', 'mrp', 'incl', 'gst', 'taxes', 'contents',
  'store', 'keep', 'below', 'room', 'temperature', 'children', 'reach',
  'for', 'the', 'and', 'with', 'each', 'contains', 'composition',
  'manufactured', 'marketed', 'india', 'schedule', 'drug', 'prescription',
  'only', 'not', 'sale', 'retail', 'return', 'from', 'this', 'that',
]);

/**
 * Parse the raw OCR text into meaningful search keywords.
 * Filters out very short words, numbers-only tokens, and common noise.
 */
export function extractKeywords(rawText: string): string[] {
  const lines = rawText
    .replace(/[^a-zA-Z0-9\s\-]/g, ' ')   // keep alphanumeric + hyphens
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 3)          // drop very short tokens
    .filter((w) => !/^\d+$/.test(w))       // drop pure numbers
    .filter((w) => !NOISE_WORDS.has(w));   // drop noise words

  // Deduplicate while preserving order
  return [...new Set(lines)];
}

/* ======================================================
   SEARCH PRODUCTS IN SUPABASE (BATCHED)
====================================================== */

/**
 * Search the products table for matches using extracted keywords.
 * Uses 3 batched parallel queries instead of N+1 sequential calls.
 */
export async function searchProductsByKeywords(
  keywords: string[],
): Promise<Product[]> {
  if (keywords.length === 0) return [];

  const seenIds = new Set<string>();
  const allMatches: Product[] = [];

  const addResults = (data: Product[] | null) => {
    if (!data) return;
    for (const p of data) {
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        allMatches.push(p);
      }
    }
  };

  // Build all queries in parallel (3 batched queries instead of up to 14)
  const phraseQuery = keywords.slice(0, 4).join(' ');
  const nameKeywords = keywords.slice(0, 8).filter((k) => k.length >= 3);
  const companyKeywords = keywords.slice(0, 5).filter((k) => k.length >= 3);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const queries: any[] = [];

  // Strategy 1: Phrase search on name
  queries.push(
    supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .ilike('name', `%${phraseQuery}%`)
      .limit(10)
      .then(({ data }) => ({ data: data as Product[] | null }))
  );

  // Strategy 2: Individual keyword search on name (batched with OR)
  if (nameKeywords.length > 0) {
    const nameFilter = nameKeywords.map((k) => `name.ilike.%${k}%`).join(',');
    queries.push(
      supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .or(nameFilter)
        .limit(30)
        .then(({ data }) => ({ data: data as Product[] | null }))
    );
  }

  // Strategy 3: Individual keyword search on company (batched with OR)
  if (companyKeywords.length > 0) {
    const companyFilter = companyKeywords.map((k) => `company.ilike.%${k}%`).join(',');
    queries.push(
      supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .or(companyFilter)
        .limit(20)
        .then(({ data }) => ({ data: data as Product[] | null }))
    );
  }

  // Execute all queries in parallel
  const results = await Promise.all(queries);
  for (const result of results) {
    addResults(result.data);
  }

  // Rank matches by relevance: count how many keywords appear in name+company
  const scored = allMatches.map((product) => {
    const text = `${product.name} ${product.company || ''}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score += 1;
    }
    return { product, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.product);
}

/* ======================================================
   MAIN SCAN FUNCTION
====================================================== */

/**
 * Full pipeline: image → OCR → keyword extraction → DB search
 */
export async function scanAndIdentifyProduct(
  base64Image: string,
): Promise<ScanResult> {
  // Step 1: Extract text from image via Google Vision
  const rawText = await extractTextFromImage(base64Image);

  if (!rawText) {
    return { extractedTexts: [], matchedProducts: [], rawText: '' };
  }

  // Step 2: Extract meaningful keywords
  const keywords = extractKeywords(rawText);

  // Step 3: Search database
  const matchedProducts = await searchProductsByKeywords(keywords);

  return {
    extractedTexts: keywords,
    matchedProducts,
    rawText,
  };
}
