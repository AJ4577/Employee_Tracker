export const ROLES = ["owner", "admin", "staff"] as const;
export type Role = (typeof ROLES)[number];
export const isAdminRole = (r: Role | null | undefined): boolean => r === "owner" || r === "admin";

export const VISIT_STATUSES = [
  "assigned",
  "in_progress",
  "arrived",
  "completed",
  "rescheduled",
  "cancelled",
  "blocked",
] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const TASK_TYPES = ["meeting", "follow_up", "delivery", "demo", "other"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TRIP_LEGS = ["outbound", "return"] as const;
export type TripLeg = (typeof TRIP_LEGS)[number];

export const LOCATION_QUALITY = ["ok", "low_accuracy", "teleport", "clock_drift", "stale", "duplicate"] as const;
export type LocationQuality = (typeof LOCATION_QUALITY)[number];

/**
 * Allowed visit status transitions. This table is mirrored by
 * private.visit_transition_allowed() in supabase/migrations; a unit test keeps
 * them in sync (tests/db/transitions.test.ts).
 */
export const VISIT_TRANSITIONS: Record<VisitStatus, readonly VisitStatus[]> = {
  assigned: ["in_progress", "rescheduled", "cancelled", "blocked"],
  rescheduled: ["in_progress", "rescheduled", "cancelled", "blocked"],
  blocked: ["assigned", "rescheduled", "cancelled"],
  in_progress: ["arrived", "rescheduled", "cancelled", "blocked"],
  arrived: ["completed", "cancelled", "blocked"],
  completed: [],
  cancelled: [],
};

export function canTransition(from: VisitStatus, to: VisitStatus): boolean {
  return VISIT_TRANSITIONS[from].includes(to);
}

export const OPEN_VISIT_STATUSES: readonly VisitStatus[] = ["assigned", "rescheduled", "in_progress", "arrived", "blocked"];

export const STATUS_LABEL: Record<VisitStatus, string> = {
  assigned: "Assigned",
  in_progress: "On the way",
  arrived: "Arrived",
  completed: "Completed",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
  blocked: "Blocked",
};

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  meeting: "Meeting",
  follow_up: "Follow-up",
  delivery: "Delivery",
  demo: "Demo",
  other: "Other",
};

export const DEFAULT_SETTINGS = {
  app_name: "KisanRoute",
  timezone: "Asia/Kolkata",
  arrival_radius_m: 100,
  low_accuracy_m: 100,
  stale_after_s: 600,
  sample_interval_s: 45,
  sample_distance_m: 75,
  route_retention_days: 90,
  reminder_offset_min: 60,
  require_admin_mfa: true,
  require_delivery_ack: false,
  require_photo_on_complete: false,
  map_tile_url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  map_tile_attribution: "&copy; OpenStreetMap contributors",
} as const;
export type OrgSettings = { -readonly [K in keyof typeof DEFAULT_SETTINGS]: (typeof DEFAULT_SETTINGS)[K] extends boolean ? boolean : (typeof DEFAULT_SETTINGS)[K] extends number ? number : string };

/** Maximum plausible ground speed (m/s) before a point is flagged as a teleport (~250 km/h). */
export const MAX_PLAUSIBLE_SPEED_MS = 70;
/** Points whose device clock is this far in the future are flagged. */
export const MAX_CLOCK_DRIFT_S = 300;
export const LOCATION_BATCH_MAX = 200;
