import { z } from "zod";
import { PRIORITIES, ROLES, TASK_TYPES } from "./constants";
import { normalizePhone } from "./phone";

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const money = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter an amount like 1250 or 1250.50");

export const productInput = z.object({
  sku: trimmed(1, 60),
  name: trimmed(1, 160),
  category: optText(80),
  unit: trimmed(1, 40),
  description: optText(4000),
  price: money.optional().nullable().or(z.literal("").transform(() => null)),
  active: z.boolean().default(true),
});
export type ProductInput = z.infer<typeof productInput>;

export const farmerInput = z.object({
  name: trimmed(1, 160),
  phone: z
    .string()
    .trim()
    .max(20)
    .optional()
    .nullable()
    .refine((v) => !v || normalizePhone(v) !== null, "Enter a valid 10-digit mobile number"),
  alt_contact: optText(120),
  village: optText(120),
  district: optText(120),
  state: optText(120),
  postcode: z
    .string()
    .trim()
    .max(10)
    .optional()
    .nullable()
    .refine((v) => !v || /^[0-9A-Za-z -]{3,10}$/.test(v), "Invalid postcode"),
  address: optText(1000),
  crops: z.array(trimmed(1, 60)).max(30).default([]),
  notes: optText(4000),
  active: z.boolean().default(true),
});
export type FarmerInput = z.infer<typeof farmerInput>;

export const distributorInput = z.object({
  name: trimmed(1, 160),
  contact_person: optText(120),
  phone: z
    .string()
    .trim()
    .max(20)
    .optional()
    .nullable()
    .refine((v) => !v || normalizePhone(v) !== null, "Enter a valid 10-digit mobile number"),
  alt_contact: optText(120),
  email: z.string().trim().max(200).optional().nullable().refine((v) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "Enter a valid email"),
  gstin: z.string().trim().max(15).optional().nullable().refine((v) => !v || /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/i.test(v), "GSTIN should be 15 characters, e.g. 27ABCDE1234F1Z5"),
  address: optText(1000),
  village: optText(120),
  district: optText(120),
  state: optText(120),
  postcode: z.string().trim().max(10).optional().nullable().refine((v) => !v || /^[0-9A-Za-z -]{3,10}$/.test(v), "Invalid postcode"),
  notes: optText(4000),
  active: z.boolean().default(true),
});
export type DistributorInput = z.infer<typeof distributorInput>;

export const purchaseItemInput = z.object({
  product_id: z.string().uuid(),
  quantity: z.string().trim().regex(/^\d{1,9}(\.\d{1,3})?$/, "Quantity like 2 or 2.5").refine((v) => Number(v) > 0, "Must be more than 0"),
  unit_price: money.optional().nullable(),
});
export const purchaseInput = z.object({
  farmer_id: z.string().uuid(),
  purchased_at: z.string().datetime({ offset: true }),
  items: z.array(purchaseItemInput).min(1, "Add at least one product").max(100),
  external_reference: optText(80),
  notes: optText(1000),
});
export type PurchaseInput = z.infer<typeof purchaseInput>;

export const visitCreateInput = z
  .object({
    farmer_id: z.string().uuid("Choose a farmer"),
    staff_id: z.string().uuid("Choose a staff member"),
    type: z.enum(TASK_TYPES),
    priority: z.enum(PRIORITIES).default("normal"),
    scheduled_at: z.string().datetime({ offset: true }),
    due_at: z.string().datetime({ offset: true }).optional().nullable(),
    timezone: z.string().min(1).default("Asia/Kolkata"),
    instructions: optText(4000),
    product_ids: z.array(z.string().uuid()).max(50).default([]),
  })
  .refine((v) => !v.due_at || Date.parse(v.due_at) >= Date.parse(v.scheduled_at), { path: ["due_at"], message: "Due time must be after the scheduled time" });
export type VisitCreateInput = z.infer<typeof visitCreateInput>;

export const reasonInput = z.string().trim().min(3, "Please give a reason (at least 3 characters)").max(500);

export const outcomeInput = z.object({
  outcome_text: z.string().trim().min(3, "Describe what happened (at least 3 characters)").max(4000),
  products_discussed: z.array(z.string().uuid()).max(50).default([]),
  next_action: optText(500),
  next_followup_at: z.string().datetime({ offset: true }).optional().nullable(),
  delivery_confirmation: z.boolean().optional().nullable(),
});
export type OutcomeInput = z.infer<typeof outcomeInput>;

export const locationPoint = z.object({
  client_event_id: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  device_time: z.string().datetime({ offset: true }),
  lat,
  lon,
  accuracy_m: z.number().nonnegative().max(100000),
  speed_ms: z.number().optional().nullable(),
});
export type LocationPoint = z.infer<typeof locationPoint>;

export const inviteInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  display_name: trimmed(1, 120),
  role: z.enum(ROLES).exclude(["owner"]),
  phone: optText(20),
  coverage_area: optText(200),
});
export type InviteInput = z.infer<typeof inviteInput>;

export const settingsPatch = z
  .object({
    organization_name: trimmed(1, 120),
    app_name: trimmed(1, 60),
    timezone: z.string().min(1),
    arrival_radius_m: z.number().int().min(20).max(5000),
    low_accuracy_m: z.number().int().min(10).max(5000),
    stale_after_s: z.number().int().min(60).max(86400),
    sample_interval_s: z.number().int().min(10).max(3600),
    sample_distance_m: z.number().int().min(5).max(5000),
    route_retention_days: z.number().int().min(7).max(3650),
    reminder_offset_min: z.number().int().min(0).max(10080),
    require_admin_mfa: z.boolean(),
    require_delivery_ack: z.boolean(),
    require_photo_on_complete: z.boolean(),
    map_tile_url: z.string().url().startsWith("https://"),
    map_tile_attribution: trimmed(1, 300),
  })
  .partial();
export type SettingsPatch = z.infer<typeof settingsPatch>;

/** Flatten a ZodError into { field: message } for forms. */
export function fieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of err.issues) {
    const k = i.path.join(".") || "_";
    if (!out[k]) out[k] = i.message;
  }
  return out;
}
