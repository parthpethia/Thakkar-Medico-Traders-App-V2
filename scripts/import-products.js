/**
 * Thakkar Medico Traders — Wholesaler Product Importer
 * 
 * This script imports product data from wholesaler exports.
 * Supported format (Tab-Separated Values - TSV):
 * ItemID   Company Division   Company   Name   SGST   CGST   CentralTax   IGST   Rate   M.R.P. [Stock]
 * 
 * Usage:
 * 1. Add SUPABASE_SERVICE_ROLE_KEY to your .env file:
 *    SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
 * 2. Run the script:
 *    node scripts/import-products.js <path_to_tsv_file>
 */

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

// 1. Read Environment Variables
function readEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const env = readEnv();
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || env.EXPO_PUBLIC_SUPABASE_URL || '';
// Service role key is required to bypass RLS policies for companies, divisions, and products
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('\x1b[31mError: Missing Supabase credentials.\x1b[0m');
  console.error('Please ensure both EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are defined in your .env file.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

// Helper to generate a URL/slug friendly string
function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
    .replace(/\-\-+/g, '-')         // Replace multiple - with single -
    .replace(/^-+/, '')             // Trim - from start of text
    .replace(/-+$/, '');            // Trim - from end of text
}

// Helper to run updates in parallel with limited concurrency
async function pLimit(items, concurrency, fn) {
  const results = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

async function main() {
  const filePathArg = process.argv[2];
  if (!filePathArg) {
    console.error('\x1b[31mError: Please provide the path to your TSV data file.\x1b[0m');
    console.error('Usage: node scripts/import-products.js <path_to_file.txt>');
    process.exit(1);
  }

  const resolvedPath = path.resolve(filePathArg);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`\x1b[31mError: File not found at path: ${resolvedPath}\x1b[0m`);
    process.exit(1);
  }

  console.log(`\n\x1b[36m⚡ Starting import from: ${resolvedPath}\x1b[0m`);

  // 2. Parse the TSV File
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const lines = content.split(/\r?\n/);
  
  if (lines.length < 2) {
    console.error('\x1b[31mError: The file is empty or missing data rows.\x1b[0m');
    process.exit(1);
  }

  // Parse Header and locate column indices
  const header = lines[0].split('\t').map(h => h.trim());
  console.log('Columns detected in file header:', header);

  const getIdx = (names) => {
    for (const name of names) {
      const idx = header.findIndex(h => h.toLowerCase() === name.toLowerCase());
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const idxSku = getIdx(['itemid', 'sku', 'productid', 'id']);
  const idxDivision = getIdx(['company division', 'division', 'divisionname']);
  const idxCompany = getIdx(['company', 'manufacturer', 'brand']);
  const idxName = getIdx(['name', 'product name', 'item name']);
  const idxSgst = getIdx(['sgst', 'sgst%']);
  const idxCgst = getIdx(['cgst', 'cgst%']);
  const idxCentralTax = getIdx(['centraltax', 'central tax']);
  const idxIgst = getIdx(['igst', 'igst%']);
  const idxRate = getIdx(['rate', 'selling price', 'price']);
  const idxMrp = getIdx(['m.r.p.', 'mrp']);
  const idxStock = getIdx(['stock', 'quantity', 'qty', 'stock_quantity']); // Optional stock column

  // Validation of required fields
  if (idxSku === -1 || idxName === -1 || idxRate === -1) {
    console.error('\x1b[31mError: Missing required columns in header.\x1b[0m');
    console.error('Make sure your file contains headers like "ItemID" (or "SKU"), "Name", and "Rate" (or "Selling Price").');
    process.exit(1);
  }

  // 3. Extract and Clean Product Records
  const parsedProducts = [];
  const uniqueCompanies = new Set();
  const uniqueDivisions = new Set(); // Format: "Company_Name::Division_Name"

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue; // Skip blank lines

    const row = line.split('\t').map(cell => cell.trim());
    if (row.length < header.length && row.length < 3) {
      console.warn(`[Line ${i + 1}] Warning: Skipping malformed line (insufficient columns)`);
      continue;
    }

    const sku = row[idxSku] || '';
    const name = row[idxName] || '';
    
    if (!sku || !name) {
      console.warn(`[Line ${i + 1}] Warning: Skipping row due to empty ItemID/SKU or Name`);
      continue;
    }

    const companyName = idxCompany !== -1 ? (row[idxCompany] || 'Unknown Company').trim() : 'Unknown Company';
    const divisionName = idxDivision !== -1 ? (row[idxDivision] || '').trim() : '';

    uniqueCompanies.add(companyName);
    if (divisionName) {
      uniqueDivisions.add(`${companyName}::${divisionName}`);
    }

    // Tax calculation
    const sgst = idxSgst !== -1 ? parseFloat(row[idxSgst]) || 0 : 0;
    const cgst = idxCgst !== -1 ? parseFloat(row[idxCgst]) || 0 : 0;
    const centralTax = idxCentralTax !== -1 ? parseFloat(row[idxCentralTax]) || 0 : 0;
    const igst = idxIgst !== -1 ? parseFloat(row[idxIgst]) || 0 : 0;
    
    // Total GST = IGST if present, else SGST + CGST, else CentralTax
    const gstPercent = igst || (sgst + cgst) || centralTax || 0;

    const rate = parseFloat(row[idxRate]) || 0;
    const mrp = idxMrp !== -1 ? parseFloat(row[idxMrp]) || rate : rate; // default mrp to rate if missing
    const stock = idxStock !== -1 ? parseInt(row[idxStock], 10) || 0 : 0;

    parsedProducts.push({
      sku,
      name,
      company: companyName,
      division: divisionName,
      gstPercent,
      sellingPrice: rate,
      mrp,
      stock,
      lineNum: i + 1
    });
  }

  console.log(`Parsed ${parsedProducts.length} valid product rows from file.`);
  console.log(`Found ${uniqueCompanies.size} unique companies and ${uniqueDivisions.size} unique divisions.`);

  // 4. Fetch existing Companies, Divisions, and Products from DB
  console.log('\nFetching current catalog from Supabase to resolve IDs...');
  
  const { data: dbCompanies, error: compErr } = await supabase
    .from('companies')
    .select('id, name');
  if (compErr) throw new Error(`Failed to load companies: ${compErr.message}`);

  const { data: dbDivisions, error: divErr } = await supabase
    .from('divisions')
    .select('id, company_id, name');
  if (divErr) throw new Error(`Failed to load divisions: ${divErr.message}`);

  // Fetch existing product SKUs
  const dbProductsMap = new Map();
  const allSkus = parsedProducts.map(p => p.sku);
  
  // Fetch in batches of 500 to avoid query size limits
  const skuBatchSize = 500;
  for (let i = 0; i < allSkus.length; i += skuBatchSize) {
    const batch = allSkus.slice(i, i + skuBatchSize);
    const { data: prods, error: prodErr } = await supabase
      .from('products')
      .select('id, sku, stock_quantity')
      .in('sku', batch);
    
    if (prodErr) throw new Error(`Failed to load existing products: ${prodErr.message}`);
    if (prods) {
      for (const p of prods) {
        dbProductsMap.set(p.sku, { id: p.id, stock_quantity: p.stock_quantity });
      }
    }
  }

  console.log(`Loaded cached data: ${dbCompanies.length} companies, ${dbDivisions.length} divisions, and mapped ${dbProductsMap.size} existing matching products.`);

  // 5. Create Missing Companies
  const companyCache = new Map(dbCompanies.map(c => [c.name.toLowerCase().trim(), c.id]));
  const companiesToInsert = [];

  for (const cName of uniqueCompanies) {
    const norm = cName.toLowerCase().trim();
    if (!companyCache.has(norm)) {
      companiesToInsert.push({
        name: cName,
        slug: slugify(cName),
        is_active: true
      });
    }
  }

  if (companiesToInsert.length > 0) {
    console.log(`Inserting ${companiesToInsert.length} new companies...`);
    const { data: insertedComps, error: insCompErr } = await supabase
      .from('companies')
      .insert(companiesToInsert)
      .select();
    
    if (insCompErr) throw new Error(`Failed inserting companies: ${insCompErr.message}`);
    
    for (const c of insertedComps) {
      companyCache.set(c.name.toLowerCase().trim(), c.id);
    }
  }

  // 6. Create Missing Divisions
  const divisionCache = new Map(dbDivisions.map(d => [`${d.company_id}::${d.name.toLowerCase().trim()}`, d.id]));
  const divisionsToInsert = [];

  for (const divStr of uniqueDivisions) {
    const [cName, dName] = divStr.split('::');
    const companyId = companyCache.get(cName.toLowerCase().trim());
    if (!companyId) continue;

    const normKey = `${companyId}::${dName.toLowerCase().trim()}`;
    if (!divisionCache.has(normKey)) {
      divisionsToInsert.push({
        company_id: companyId,
        name: dName,
        slug: slugify(dName),
        is_active: true
      });
    }
  }

  if (divisionsToInsert.length > 0) {
    console.log(`Inserting ${divisionsToInsert.length} new divisions...`);
    const { data: insertedDivs, error: insDivErr } = await supabase
      .from('divisions')
      .insert(divisionsToInsert)
      .select();
    
    if (insDivErr) throw new Error(`Failed inserting divisions: ${insDivErr.message}`);
    
    for (const d of insertedDivs) {
      divisionCache.set(`${d.company_id}::${d.name.toLowerCase().trim()}`, d.id);
    }
  }

  // 7. Sort Products into Insert vs Update lists
  const productsToInsert = [];
  const productsToUpdate = [];

  for (const p of parsedProducts) {
    const companyId = companyCache.get(p.company.toLowerCase().trim()) || null;
    const divisionKey = companyId ? `${companyId}::${p.division.toLowerCase().trim()}` : '';
    const divisionId = divisionCache.get(divisionKey) || null;

    const prodPayload = {
      sku: p.sku,
      name: p.name,
      company: p.company,
      company_id: companyId,
      division_id: divisionId,
      gst_percent: p.gstPercent,
      selling_price: p.sellingPrice,
      mrp: p.mrp,
      is_active: true
    };

    if (dbProductsMap.has(p.sku)) {
      const existing = dbProductsMap.get(p.sku);
      productsToUpdate.push({
        id: existing.id,
        payload: prodPayload,
        stock: p.stock,
        existingStock: existing.stock_quantity
      });
    } else {
      productsToInsert.push({
        payload: prodPayload,
        stock: p.stock
      });
    }
  }

  console.log(`\nImport Classification:`);
  console.log(` - Products to INSERT (New SKU): ${productsToInsert.length}`);
  console.log(` - Products to UPDATE (Existing SKU): ${productsToUpdate.length}`);

  // 8. Bulk Insert New Products
  const newlyInsertedProducts = [];
  if (productsToInsert.length > 0) {
    console.log(`\nInserting ${productsToInsert.length} new products in batches of 200...`);
    const batchSize = 200;
    for (let i = 0; i < productsToInsert.length; i += batchSize) {
      const batch = productsToInsert.slice(i, i + batchSize);
      const payloads = batch.map(b => b.payload);
      
      const { data: inserted, error: prodInsErr } = await supabase
        .from('products')
        .insert(payloads)
        .select('id, sku');

      if (prodInsErr) {
        console.error(`Failed to insert batch starting at index ${i}:`, prodInsErr.message);
        throw prodInsErr;
      }
      
      if (inserted) {
        newlyInsertedProducts.push(...inserted);
        // Map stocks if quantity > 0
        const stockBatches = [];
        for (let j = 0; j < inserted.length; j++) {
          const matchedItem = batch[j];
          if (matchedItem.stock > 0) {
            stockBatches.push({
              product_id: inserted[j].id,
              batch_number: 'LEGACY',
              quantity: matchedItem.stock,
              cost_price: null,
              is_active: true
            });
          }
        }
        
        if (stockBatches.length > 0) {
          const { error: batchErr } = await supabase
            .from('product_batches')
            .insert(stockBatches);
          if (batchErr) {
            console.error(`Warning: Failed to create stock batches for new products:`, batchErr.message);
          }
        }
      }
      console.log(`  Inserted ${newlyInsertedProducts.length}/${productsToInsert.length}`);
    }
  }

  // 9. Update Existing Products (with Concurrency Limit)
  let updatedCount = 0;
  if (productsToUpdate.length > 0) {
    console.log(`\nUpdating ${productsToUpdate.length} existing products...`);
    
    await pLimit(productsToUpdate, 15, async (item) => {
      const { error: updErr } = await supabase
        .from('products')
        .update(item.payload)
        .eq('id', item.id);

      if (updErr) {
        console.error(`Failed to update SKU ${item.payload.sku}:`, updErr.message);
      } else {
        updatedCount++;
        
        // If stock has been supplied and is different or needs adjustment
        if (item.stock > 0 && item.stock !== item.existingStock) {
          // Check if LEGACY batch exists for this product
          const { data: existingBatches } = await supabase
            .from('product_batches')
            .select('id')
            .eq('product_id', item.id)
            .eq('batch_number', 'LEGACY')
            .limit(1);

          if (existingBatches && existingBatches.length > 0) {
            // Update the quantity of the LEGACY batch
            await supabase
              .from('product_batches')
              .update({ quantity: item.stock })
              .eq('id', existingBatches[0].id);
          } else {
            // Create a new LEGACY batch
            await supabase
              .from('product_batches')
              .insert({
                product_id: item.id,
                batch_number: 'LEGACY',
                quantity: item.stock,
                is_active: true
              });
          }
        }
      }

      if (updatedCount % 200 === 0) {
        console.log(`  Updated ${updatedCount}/${productsToUpdate.length}`);
      }
    });
    console.log(`Completed existing product updates: ${updatedCount} successful.`);
  }

  console.log(`\n\x1b[32m✔ Import Completed Successfully!\x1b[0m`);
  console.log(`Total created: ${productsToInsert.length}`);
  console.log(`Total updated: ${updatedCount}`);
}

main().catch(err => {
  console.error('\x1b[31mImport crashed with an unhandled exception:\x1b[0m');
  console.error(err);
  process.exit(1);
});
