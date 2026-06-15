import * as fs from 'fs';
import * as path from 'path';

/**
 * Smoke test: Verify that every key in en.json exists in hi.json.
 * Lists ALL missing keys at once for easy remediation.
 */
describe('i18n coverage', () => {
  const I18N_DIR = path.resolve(__dirname, '../../src/i18n');

  function flattenKeys(obj: Record<string, any>, prefix = ''): string[] {
    const keys: string[] = [];
    for (const key of Object.keys(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
        keys.push(...flattenKeys(obj[key], fullKey));
      } else {
        keys.push(fullKey);
      }
    }
    return keys;
  }

  it('hi.json contains every key that en.json contains', () => {
    const enPath = path.join(I18N_DIR, 'en.json');
    const hiPath = path.join(I18N_DIR, 'hi.json');

    expect(fs.existsSync(enPath)).toBe(true);
    expect(fs.existsSync(hiPath)).toBe(true);

    const en = JSON.parse(fs.readFileSync(enPath, 'utf-8'));
    const hi = JSON.parse(fs.readFileSync(hiPath, 'utf-8'));

    const enKeys = flattenKeys(en);
    const hiKeys = new Set(flattenKeys(hi));

    expect(enKeys.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const key of enKeys) {
      if (!hiKeys.has(key)) {
        missing.push(key);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `${missing.length} English keys missing from Hindi translations:\n` +
        missing.map((m) => `  - ${m}`).join('\n')
      );
    }
  });

  it('en.json contains every key that hi.json contains (no orphan Hindi keys)', () => {
    const enPath = path.join(I18N_DIR, 'en.json');
    const hiPath = path.join(I18N_DIR, 'hi.json');

    const en = JSON.parse(fs.readFileSync(enPath, 'utf-8'));
    const hi = JSON.parse(fs.readFileSync(hiPath, 'utf-8'));

    const enKeys = new Set(flattenKeys(en));
    const hiKeys = flattenKeys(hi);

    const orphans: string[] = [];
    for (const key of hiKeys) {
      if (!enKeys.has(key)) {
        orphans.push(key);
      }
    }

    if (orphans.length > 0) {
      throw new Error(
        `${orphans.length} Hindi keys have no English counterpart:\n` +
        orphans.map((m) => `  - ${m}`).join('\n')
      );
    }
  });

  it('no empty translation values in en.json', () => {
    const enPath = path.join(I18N_DIR, 'en.json');
    const en = JSON.parse(fs.readFileSync(enPath, 'utf-8'));

    function checkEmpty(obj: Record<string, any>, prefix = ''): string[] {
      const empties: string[] = [];
      for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          empties.push(...checkEmpty(obj[key], fullKey));
        } else if (typeof obj[key] === 'string' && obj[key].trim() === '') {
          empties.push(fullKey);
        }
      }
      return empties;
    }

    const empties = checkEmpty(en);
    if (empties.length > 0) {
      throw new Error(`Empty translation values in en.json:\n${empties.map((e) => `  - ${e}`).join('\n')}`);
    }
  });
});
