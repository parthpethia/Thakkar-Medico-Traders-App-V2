/**
 * Verifies public tables exist (run after supabase/setup.sql).
 * Usage: npm run verify:schema
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

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

function get(url, apikey) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { apikey, Authorization: `Bearer ${apikey}` } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
  });
}

async function main() {
  const env = readEnv();
  const base = (process.env.EXPO_PUBLIC_SUPABASE_URL || env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

  if (!base || !key) {
    console.error('Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY in .env');
    process.exit(1);
  }

  const tables = [
    'profiles',
    'categories',
    'products',
    'cart_items',
    'orders',
    'settings',
    'stock_history',
  ];

  let ok = true;
  for (const table of tables) {
    const url = `${base}/rest/v1/${table}?select=*&limit=1`;
    const { status, body } = await get(url, key);
    if (status === 200) {
      console.log(`OK  ${table}`);
    } else {
      ok = false;
      console.error(`FAIL ${table} HTTP ${status}`);
      if (body) console.error(body.slice(0, 200));
    }
  }

  const migUrl = `${base}/rest/v1/rpc/version`;
  console.log('\nIf any table FAILs, run supabase/setup.sql in Supabase SQL Editor.');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
