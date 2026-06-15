import {
  buildOrderLink,
  buildAdminOrderLink,
  buildStockLink,
  parseDeepLink,
} from '../../src/utils/deepLink';

describe('Deep Link Builders', () => {
  it('buildOrderLink produces correct URL', () => {
    expect(buildOrderLink('abc123')).toBe('thakkarmedico://order/abc123');
  });

  it('buildAdminOrderLink produces correct URL', () => {
    expect(buildAdminOrderLink('xyz789')).toBe('thakkarmedico://admin/orders/xyz789');
  });

  it('buildStockLink produces correct URL', () => {
    expect(buildStockLink()).toBe('thakkarmedico://admin/stock');
  });
});

describe('parseDeepLink', () => {
  it('parses order deep link', () => {
    const result = parseDeepLink('thakkarmedico://order/abc123');
    expect(result).toEqual({
      screen: '/order/[id]',
      params: { id: 'abc123' },
    });
  });

  it('parses admin order deep link', () => {
    const result = parseDeepLink('thakkarmedico://admin/orders/xyz789');
    expect(result).toEqual({
      screen: '/admin/orders/[id]',
      params: { id: 'xyz789' },
    });
  });

  it('parses admin stock deep link', () => {
    const result = parseDeepLink('thakkarmedico://admin/stock');
    expect(result).toEqual({
      screen: '/admin/stock',
      params: {},
    });
  });

  it('parses auth reset-password deep link', () => {
    const result = parseDeepLink('thakkarmedico://auth/reset-password');
    expect(result).toEqual({
      screen: '/auth/reset-password',
      params: {},
    });
  });

  it('returns null for unknown scheme', () => {
    expect(parseDeepLink('https://example.com/order/123')).toBeNull();
  });

  it('returns null for empty path', () => {
    expect(parseDeepLink('thakkarmedico://')).toBeNull();
  });

  it('returns null for unrecognized path', () => {
    expect(parseDeepLink('thakkarmedico://settings')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseDeepLink('')).toBeNull();
  });

  it('returns null for order link without ID', () => {
    expect(parseDeepLink('thakkarmedico://order')).toBeNull();
    expect(parseDeepLink('thakkarmedico://order/')).toBeNull();
  });

  it('handles UUID-style order IDs', () => {
    const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const result = parseDeepLink(`thakkarmedico://order/${uuid}`);
    expect(result).toEqual({
      screen: '/order/[id]',
      params: { id: uuid },
    });
  });
});
