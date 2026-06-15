import * as fs from 'fs';
import * as path from 'path';

/**
 * Smoke test: Verify that every supabase.rpc() call in the codebase references
 * a function defined in the migration SQL files.
 */
describe('RPC names match migrations', () => {
  const PROJECT_ROOT = path.resolve(__dirname, '../../');
  const SUPABASE_DIR = path.join(PROJECT_ROOT, 'supabase');
  const SRC_DIRS = [
    path.join(PROJECT_ROOT, 'src'),
    path.join(PROJECT_ROOT, 'app'),
  ];

  function findSqlFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => path.join(dir, f));
  }

  function extractFunctionNames(sqlContent: string): Set<string> {
    const names = new Set<string>();
    // Match CREATE [OR REPLACE] FUNCTION [public.]function_name
    const regex = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([\w]+)/gi;
    let match;
    while ((match = regex.exec(sqlContent)) !== null) {
      const name = match[1];
      // Skip internal PG names
      if (name !== 'public') {
        names.add(name);
      }
    }
    return names;
  }

  function findTsFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        results.push(...findTsFiles(fullPath));
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        results.push(fullPath);
      }
    }
    return results;
  }

  function extractRpcCalls(tsContent: string): string[] {
    const calls: string[] = [];
    // Match supabase.rpc('function_name' or supabase.rpc("function_name"
    const regex = /\.rpc\(\s*['"](\w+)['"]/g;
    let match;
    while ((match = regex.exec(tsContent)) !== null) {
      calls.push(match[1]);
    }
    return calls;
  }

  it('all RPC calls reference functions defined in migration SQL files', () => {
    // 1. Collect all SQL function names
    const sqlFiles = [
      ...findSqlFiles(SUPABASE_DIR),
      ...findSqlFiles(PROJECT_ROOT),
    ];
    expect(sqlFiles.length).toBeGreaterThan(0);

    const definedFunctions = new Set<string>();
    for (const sqlFile of sqlFiles) {
      const content = fs.readFileSync(sqlFile, 'utf-8');
      const names = extractFunctionNames(content);
      names.forEach((n) => definedFunctions.add(n));
    }

    // 2. Collect all RPC calls from TypeScript files
    const allRpcCalls = new Set<string>();
    for (const srcDir of SRC_DIRS) {
      const tsFiles = findTsFiles(srcDir);
      for (const tsFile of tsFiles) {
        const content = fs.readFileSync(tsFile, 'utf-8');
        const calls = extractRpcCalls(content);
        calls.forEach((c) => allRpcCalls.add(c));
      }
    }

    expect(allRpcCalls.size).toBeGreaterThan(0);

    // 3. Check every RPC call is defined
    const missing: string[] = [];
    for (const rpcName of allRpcCalls) {
      if (!definedFunctions.has(rpcName)) {
        missing.push(rpcName);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `The following RPC calls are not defined in migration SQL files:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        `\n\nDefined functions: ${[...definedFunctions].sort().join(', ')}`
      );
    }
  });
});
