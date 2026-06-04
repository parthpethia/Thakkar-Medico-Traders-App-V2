export type UserRole = 'admin' | 'retailer' | 'delivery';

export interface AppUser {
  id: string;
  email: string;
  phone: string | null;
  name: string | null;

  role: UserRole;
  approved: boolean;

  business_name?: string | null;
  address?: string | null;

  loyalty_points?: number;
  credit_limit?: number;
  credit_used?: number;

  created_at: string;
}
