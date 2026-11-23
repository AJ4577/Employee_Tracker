// Row and RPC result types aligned with supabase/migrations. Keep in sync when the schema changes
// (or regenerate with `supabase gen types typescript` and adapt).
import type { LocationQuality, Priority, Role, TaskType, TripLeg, VisitStatus } from "./constants";
import type { OrgSettings } from "./constants";

export interface Profile {
  id: string;
  organization_id: string;
  role: Role;
  status: "invited" | "pending" | "active" | "suspended";
  display_name: string;
  email: string;
  phone: string | null;
  coverage_area: string | null;
  manager_id: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface DutySession {
  id: string;
  staff_id: string;
  mode: "tracking" | "limited";
  started_at: string;
  ended_at: string | null;
}

export interface Trip {
  id: string;
  visit_id: string;
  staff_id: string;
  leg: TripLeg;
  status: "active" | "ended" | "abandoned";
  started_at: string;
  ended_at: string | null;
  last_sequence: number;
  travel_mode?: TravelMode | null;
}

export type TravelMode = "walk" | "bike" | "car";
export const TRAVEL_MODE_LABEL: Record<TravelMode, string> = { walk: "Walking", bike: "Bike", car: "Car" };
export const TRAVEL_MODE_ICON: Record<TravelMode, string> = { walk: "🚶", bike: "🏍️", car: "🚗" };

export interface Me {
  profile: Profile;
  settings: (OrgSettings & { organization_name: string }) | null;
  aal: "aal1" | "aal2";
  is_admin: boolean;
  duty: DutySession | null;
  active_trip: Trip | null;
  unread_notifications: number;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  unit: string;
  description: string | null;
  price: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Farmer {
  id: string;
  name: string;
  phone: string | null;
  normalized_phone: string | null;
  alt_contact: string | null;
  village: string | null;
  district: string | null;
  state: string | null;
  postcode: string | null;
  address: string | null;
  crops: string[];
  notes: string | null;
  lat: number | null;
  lon: number | null;
  location_verified: boolean;
  geocode_source: string | null;
  location_confirmed_at: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Visit {
  id: string;
  farmer_id: string;
  staff_id: string;
  type: TaskType;
  instructions: string | null;
  scheduled_at: string;
  timezone: string;
  due_at: string | null;
  priority: Priority;
  status: VisitStatus;
  product_ids: string[];
  target_lat: number | null;
  target_lon: number | null;
  started_at: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  status_reason: string | null;
  parent_visit_id: string | null;
  version: number;
  created_at: string;
}

export interface VisitEvent {
  id?: string;
  event_type: string;
  from_status?: VisitStatus | null;
  to_status?: VisitStatus | null;
  occurred_at: string;
  received_at: string;
  lat?: number | null;
  lon?: number | null;
  accuracy_m: number | null;
  distance_m: number | null;
  source?: string;
  reason: string | null;
  flagged: boolean;
  actor_name?: string | null;
  metadata?: Record<string, unknown>;
}

export interface VisitOutcome {
  visit_id: string;
  outcome_text: string;
  products_discussed: string[];
  next_action: string | null;
  next_followup_at: string | null;
  delivery_confirmation: boolean | null;
  recorded_at: string;
  device_recorded_at: string | null;
}

export interface MyVisitListItem {
  id: string;
  type: TaskType;
  status: VisitStatus;
  priority: Priority;
  scheduled_at: string;
  timezone: string;
  due_at: string | null;
  instructions: string | null;
  version: number;
  started_at: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  target_lat: number | null;
  target_lon: number | null;
  farmer_name: string;
  village: string | null;
  district: string | null;
  location_verified: boolean;
  active_trip_id: string | null;
  return_recorded: boolean;
}

export interface MyVisitDetail {
  visit: Visit;
  farmer: Pick<Farmer, "id" | "name" | "phone" | "alt_contact" | "village" | "district" | "state" | "postcode" | "address" | "crops" | "lat" | "lon" | "location_verified">;
  recent_purchases: { purchased_at: string; items: { name: string; quantity: string; unit: string }[] | null }[];
  products: { id: string; name: string; sku: string }[];
  events: VisitEvent[];
  outcome: VisitOutcome | null;
  trips: Trip[];
  attachments: { id: string; storage_path: string; mime_type: string; kind: string; created_at: string }[];
}

export interface AdminVisitDetail {
  visit: Visit;
  farmer: Farmer;
  staff: { id: string; display_name: string; status: string };
  events: VisitEvent[];
  outcome: VisitOutcome | null;
  trips: Trip[];
  products: { id: string; name: string; sku: string }[];
  attachments: { id: string; storage_path: string; mime_type: string; kind: string; created_at: string }[];
}

export interface StaffBoardRow {
  id: string;
  display_name: string;
  status: Profile["status"];
  coverage_area: string | null;
  last_seen_at: string | null;
  duty_id: string | null;
  duty_started_at: string | null;
  duty_mode: "tracking" | "limited" | null;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  device_time: string | null;
  received_at: string | null;
  quality: LocationQuality | null;
  trip_id: string | null;
  active_visit_id: string | null;
  active_leg: TripLeg | null;
  active_farmer: string | null;
  open_visits: number;
  overdue_visits: number;
}

export interface Overview {
  active_products: number;
  active_farmers: number;
  active_staff: number;
  on_duty: number;
  visits_in_range: number;
  by_status: Partial<Record<VisitStatus, number>>;
  overdue: number;
  in_progress_now: number;
  flagged_arrivals: number;
  server_time: string;
}

export interface FeedItem {
  id: string;
  visit_id: string;
  event_type: string;
  occurred_at: string;
  received_at: string;
  reason: string | null;
  flagged: boolean;
  distance_m: number | null;
  accuracy_m: number | null;
  source: string;
  actor_name: string | null;
  farmer_name: string;
  village: string | null;
}

/** [lat, lon, accuracy_m, device_time, trip_id, quality] */
export type RoutePoint = [number, number, number, string, string | null, LocationQuality];

export interface StaffRoute {
  points: RoutePoint[];
  flagged_count: number;
  trips: { id: string; visit_id: string; leg: TripLeg; status: string; started_at: string; ended_at: string | null; farmer_name: string; travel_mode: TravelMode | null }[];
  duty: { started_at: string; ended_at: string | null; mode: string }[];
}

export interface UserNotification {
  id: string;
  type: string;
  visit_id: string | null;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
}

export const EVENT_LABEL: Record<string, string> = {
  assigned: "Assigned",
  updated: "Details updated",
  reassigned: "Reassigned",
  cancelled: "Cancelled",
  rescheduled: "Rescheduled",
  trip_started: "Left for visit",
  arrived: "Arrived at farm",
  completed: "Meeting completed",
  return_started: "Return trip started",
  return_ended: "Returned",
  trip_ended_by_duty: "Trip closed at duty end",
};
