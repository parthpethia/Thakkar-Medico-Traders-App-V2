const SCHEME = 'thakkarmedico';

export function buildOrderLink(orderId: string): string {
  return `${SCHEME}://order/${orderId}`;
}

export function buildAdminOrderLink(orderId: string): string {
  return `${SCHEME}://admin/orders/${orderId}`;
}

export function buildStockLink(): string {
  return `${SCHEME}://admin/stock`;
}

export function parseDeepLink(url: string): { screen: string; params: Record<string, string> } | null {
  try {
    const prefix = `${SCHEME}://`;
    if (!url.startsWith(prefix)) return null;

    const path = url.slice(prefix.length);
    const segments = path.split('/').filter(Boolean);

    if (segments.length === 0) return null;

    // thakkarmedico://order/[id]
    if (segments[0] === 'order' && segments[1]) {
      return { screen: '/order/[id]', params: { id: segments[1] } };
    }

    // thakkarmedico://admin/orders/[id]
    if (segments[0] === 'admin' && segments[1] === 'orders' && segments[2]) {
      return { screen: '/admin/orders/[id]', params: { id: segments[2] } };
    }

    // thakkarmedico://admin/stock
    if (segments[0] === 'admin' && segments[1] === 'stock') {
      return { screen: '/admin/stock', params: {} };
    }

    if (segments[0] === 'auth' && segments[1] === 'reset-password') {
      return { screen: '/auth/reset-password', params: {} };
    }

    return null;
  } catch {
    return null;
  }
}
