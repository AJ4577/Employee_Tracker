/** Map backend error codes (raised by private.raise_err / Edge Functions) to user-facing text. */
export const ERROR_TEXT: Record<string, string> = {
  forbidden: "You don't have permission to do that.",
  not_found: "This record doesn't exist or you no longer have access to it.",
  unauthenticated: "Please sign in again.",
  no_profile: "Your account is not set up yet. Ask your administrator to invite you.",
  validation: "Some details are missing or invalid.",
  invalid_transition: "This action isn't allowed in the visit's current state. Refresh to see the latest status.",
  version_conflict: "Someone else changed this record. Refresh and try again.",
  reason_required: "You're not within the farm area (or GPS is weak/unavailable). Add a short reason to continue.",
  duty_not_started: "Start your duty first.",
  active_trip_exists: "You already have a trip in progress. Finish it first.",
  tracking_disabled: "Location sharing is off for this duty (limited mode).",
  invitation_expired: "This invitation has expired. Ask your administrator for a new one.",
  invitation_not_found: "No pending invitation was found for this account.",
  rate_limited: "Too many requests. Please wait a moment.",
  provider_not_configured: "This feature needs a provider to be configured by your administrator.",
  network: "You appear to be offline. Changes will be retried.",
};

export interface AppError {
  code: string;
  message: string;
  detail?: Record<string, unknown> | null;
}

export function toAppError(e: unknown): AppError {
  const anyE = e as { message?: string; details?: string; detail?: string; code?: string; name?: string } | null;
  const raw = anyE?.message ?? String(e);
  if (/Failed to fetch|NetworkError|Network request failed|fetch failed/i.test(raw)) {
    return { code: "network", message: ERROR_TEXT.network! };
  }
  const code = Object.prototype.hasOwnProperty.call(ERROR_TEXT, raw) ? raw : /permission denied|row-level security/i.test(raw) ? "forbidden" : "unknown";
  let detail: Record<string, unknown> | null = null;
  const d = anyE?.details ?? anyE?.detail;
  if (d) {
    try {
      detail = JSON.parse(d);
    } catch {
      detail = null;
    }
  }
  let message = ERROR_TEXT[code] ?? raw ?? "Something went wrong.";
  if (code === "validation" && detail && typeof detail.message === "string") message = detail.message;
  else if (code === "validation" && detail && typeof detail.field === "string") message = `Please check: ${detail.field}`;
  return { code, message, detail };
}
