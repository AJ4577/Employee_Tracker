import { describe, expect, test } from "vitest";
import {
  canTransition,
  classifyPoint,
  csvCell,
  dayRangeInTz,
  distanceMeters,
  evaluateGeofence,
  formatDuration,
  freshness,
  googleDirectionsUrl,
  lineTotalMinor,
  fromMinor,
  maskPhone,
  normalizePhone,
  outcomeInput,
  toAppError,
  toMinor,
  visitCreateInput,
  zonedToUtc,
} from "./index";

describe("geo", () => {
  test("haversine distance", () => {
    expect(distanceMeters({ lat: 18.5204, lon: 73.8567 }, { lat: 19.076, lon: 72.8777 })).toBeGreaterThan(118000);
    expect(distanceMeters({ lat: 18.5204, lon: 73.8567 }, { lat: 19.076, lon: 72.8777 })).toBeLessThan(121000);
    expect(distanceMeters({ lat: 1, lon: 1 }, { lat: 1, lon: 1 })).toBe(0);
  });
  test("geofence", () => {
    const pin = { lat: 18.7357, lon: 73.6755 };
    expect(evaluateGeofence({ lat: 18.736, lon: 73.6757, accuracy_m: 10 }, pin, 100, 100).kind).toBe("inside");
    expect(evaluateGeofence({ lat: 18.75, lon: 73.7, accuracy_m: 10 }, pin, 100, 100).kind).toBe("outside");
    expect(evaluateGeofence({ lat: 18.736, lon: 73.6757, accuracy_m: 300 }, pin, 100, 100).kind).toBe("low_accuracy");
    expect(evaluateGeofence(null, pin, 100, 100).kind).toBe("no_device_fix");
    expect(evaluateGeofence({ lat: 1, lon: 1, accuracy_m: 1 }, null, 100, 100).kind).toBe("no_target_pin");
  });
  test("point classification", () => {
    const now = Date.parse("2026-11-20T10:00:00Z");
    const prev = { lat: 18.5, lon: 73.8, accuracy_m: 10, device_time: "2026-11-20T09:59:00Z" };
    expect(classifyPoint({ lat: 18.5005, lon: 73.8, accuracy_m: 10, device_time: "2026-11-20T10:00:00Z" }, prev, now, 100)).toBe("ok");
    expect(classifyPoint({ lat: 28.6, lon: 77.2, accuracy_m: 10, device_time: "2026-11-20T10:00:00Z" }, prev, now, 100)).toBe("teleport");
    expect(classifyPoint({ lat: 18.5, lon: 73.8, accuracy_m: 500, device_time: "2026-11-20T10:00:00Z" }, prev, now, 100)).toBe("low_accuracy");
    expect(classifyPoint({ lat: 18.5, lon: 73.8, accuracy_m: 5, device_time: "2026-11-20T11:00:00Z" }, prev, now, 100)).toBe("clock_drift");
  });
  test("freshness never live when off duty", () => {
    const now = Date.parse("2026-11-20T10:00:00Z");
    expect(freshness("2026-11-20T09:59:00Z", true, 600, now)).toBe("live");
    expect(freshness("2026-11-20T09:40:00Z", true, 600, now)).toBe("stale");
    expect(freshness("2026-11-20T09:59:00Z", false, 600, now)).toBe("last_known");
    expect(freshness(null, true, 600, now)).toBe("unavailable");
  });
  test("directions URL contains only coordinates", () => {
    const u = googleDirectionsUrl({ lat: 18.7357, lon: 73.6755 });
    expect(u).toContain("destination=18.735700%2C73.675500");
    expect(u).toContain("api=1");
  });
});

describe("transitions", () => {
  test("completed is terminal", () => {
    expect(canTransition("completed", "in_progress")).toBe(false);
    expect(canTransition("assigned", "in_progress")).toBe(true);
    expect(canTransition("assigned", "completed")).toBe(false);
  });
});

describe("money", () => {
  test("integer minor units", () => {
    expect(toMinor("128.5")).toBe(12850);
    expect(fromMinor(12850)).toBe("128.50");
    expect(lineTotalMinor("2.5", "128.50")).toBe(32125);
    expect(lineTotalMinor("3", "99.99")).toBe(29997);
    expect(lineTotalMinor("0.333", "10.00")).toBe(333);
    expect(() => toMinor("1.234")).toThrow();
  });
});

describe("time", () => {
  test("IST day range", () => {
    const [s, e] = dayRangeInTz("Asia/Kolkata", new Date("2026-11-20T20:00:00Z"));
    expect(s).toBe("2026-11-20T18:30:00.000Z");
    expect(e).toBe("2026-11-21T18:30:00.000Z");
  });
  test("zoned to UTC", () => {
    expect(zonedToUtc("2026-11-20T10:00", "Asia/Kolkata").toISOString()).toBe("2026-11-20T04:30:00.000Z");
  });
  test("duration", () => {
    expect(formatDuration("2026-11-20T10:00:00Z", "2026-11-20T11:25:00Z")).toBe("1 h 25 min");
    expect(formatDuration(null, "2026-11-20T11:25:00Z")).toBe("Not recorded");
  });
});

describe("phone", () => {
  test("normalize and mask", () => {
    expect(normalizePhone("98765 43210")).toBe("+919876543210");
    expect(normalizePhone("098765-43210")).toBe("+919876543210");
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
    expect(normalizePhone("123")).toBeNull();
    expect(maskPhone("+919876543210")).toBe("+••••••••3210");
  });
});

describe("schemas", () => {
  test("visit due must be after schedule", () => {
    const r = visitCreateInput.safeParse({
      farmer_id: "8a1b5a52-5e8f-4f43-9c3e-1d1d1d1d1d1d",
      staff_id: "8a1b5a52-5e8f-4f43-9c3e-1d1d1d1d1d1e",
      type: "meeting",
      scheduled_at: "2026-11-20T10:00:00+05:30",
      due_at: "2026-11-20T09:00:00+05:30",
    });
    expect(r.success).toBe(false);
  });
  test("outcome requires text", () => {
    expect(outcomeInput.safeParse({ outcome_text: " " }).success).toBe(false);
  });
});

describe("csv", () => {
  test("formula injection neutralised and quoting", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
  });
});

describe("errors", () => {
  test("maps backend codes", () => {
    expect(toAppError({ message: "reason_required", details: '{"distance_m":3000}' }).detail).toEqual({ distance_m: 3000 });
    expect(toAppError(new TypeError("Failed to fetch")).code).toBe("network");
    expect(toAppError({ message: "validation", details: '{"field":"phone","message":"Invalid phone number"}' }).message).toBe("Invalid phone number");
  });
});
