export type VenueType = 'happy_restaurant' | 'happy_bar' | 'happy_hybrid';
export type StaffRole = 'waiter' | 'manager' | 'kitchen' | 'bar' | 'admin';
export type Destination = 'kitchen' | 'bar' | 'printer';
export type TableStatus = 'available' | 'occupied' | 'bill_requested' | 'reserved' | 'closed';
export type OrderStatus = 'open' | 'bill_requested' | 'paid' | 'voided';
export type OrderItemStatus = 'pending' | 'sent' | 'in_progress' | 'ready' | 'delivered' | 'voided';

export interface Venue {
  id: string;
  code: string;
  name: string;
  venue_type: VenueType;
  currency: string;
  timezone: string;
  counter_service_enabled: boolean;
  send_by_course: boolean;
  kitchen_display_enabled: boolean;
  bar_display_enabled: boolean;
  default_item_destination: Destination;
  waiter_login_method: 'pin' | 'email' | 'both';
  created_at: string;
  updated_at: string;
}

export interface Staff {
  id: string;
  venue_id: string;
  name: string;
  email: string | null;
  pin_hash: string | null;
  role: StaffRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RestaurantTable {
  id: string;
  venue_id: string;
  number: number | null;
  name: string | null;
  section: string | null;
  capacity: number;
  status: TableStatus;
  current_order_id: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface MenuCategory {
  id: string;
  venue_id: string;
  name: string;
  description: string | null;
  destination: Destination;
  sort_order: number;
  is_active: boolean;
}

export interface MenuItem {
  id: string;
  venue_id: string;
  category_id: string;
  name: string;
  description: string | null;
  price: number;
  destination_override: Destination | null;
  course: string | null;
  is_available: boolean;
  sort_order: number;
  is_active: boolean;
}

export interface Order {
  id: string;
  venue_id: string;
  table_id: string | null;
  waiter_id: string;
  order_number: number;
  ticket_number: number | null;
  status: OrderStatus;
  subtotal: number;
  discount: number;
  total: number;
  notes: string | null;
  opened_at: string;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  venue_id: string;
  menu_item_id: string;
  name: string;
  unit_price: number;
  total_price: number;
  quantity: number;
  course: string | null;
  destination: Destination;
  status: OrderItemStatus;
  sent_at: string | null;
  notes: string | null;
}

export interface KitchenEventItem {
  name: string;
  quantity: number;
  notes?: string | null;
  course?: string | null;
}

export interface KitchenEvent {
  id: string;
  venue_id: string;
  order_id: string;
  table_id: string | null;
  table_display: string | null;
  event_type: string;
  destination: 'kitchen' | 'bar';
  course: string | null;
  items: KitchenEventItem[];
  is_acknowledged: boolean;
  acknowledged_at: string | null;
  created_at: string;
}

// JWT payload issued at login
export interface AuthTokenPayload {
  staffId: string;
  venueId: string;
  venueType: VenueType;
  role: StaffRole;
}

// req.user, attached by middleware/auth.ts
export interface AuthenticatedUser extends AuthTokenPayload {
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
