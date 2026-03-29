const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns/promises');
const https = require('node:https');

function readEnvFile() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};

  const raw = fs.readFileSync(envPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const result = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    result[key] = value;
  }

  return result;
}

function head(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'HEAD', timeout: 12000 },
      (res) => {
        resolve(res.statusCode || 0);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const env = readEnvFile();
  const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || env.EXPO_PUBLIC_SUPABASE_URL || '').trim();

  if (!supabaseUrl) {
    console.error('Missing EXPO_PUBLIC_SUPABASE_URL in .env');
    process.exit(1);
  }

  let host;
  try {
    host = new URL(supabaseUrl).host;
  } catch {
    console.error(`Invalid EXPO_PUBLIC_SUPABASE_URL: ${supabaseUrl}`);
    process.exit(1);
  }

  console.log(`Checking DNS for ${host}...`);
  try {
    const records = await dns.lookup(host, { all: true });
    console.log('DNS OK:', records.map((r) => r.address).join(', '));
  } catch (e) {
    console.error(`DNS FAIL: ${host} does not resolve (${e.code || e.message})`);
    process.exit(1);
  }

  const restUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/`;
  console.log(`Checking HTTPS HEAD ${restUrl} ...`);
  try {
    const status = await head(restUrl);
    console.log(`HTTP OK: status ${status}`);
    process.exit(0);
  } catch (e) {
    console.error(`HTTP FAIL: ${e.code || e.message}`);
    process.exit(1);
  }
}

main();
