
// Used ONLY for UI & cart store
// UI Cart Item (used by components & screens ONLY)
export interface UICartItem {
  productId: string;
  name: string;
  image?: string;
  price: number;
  gstPercent: number;
  quantity: number;
}
