import { toAppError, type AppError } from "@kisanroute/shared";
import { supabase } from "./supabase";

export class ApiError extends Error implements AppError {
  code: string;
  detail?: Record<string, unknown> | null;
  constructor(e: AppError) {
    super(e.message);
    this.code = e.code;
    this.detail = e.detail;
  }
}

/** Call a Postgres RPC; throws ApiError with a user-facing message. */
export async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new ApiError(toAppError(error));
  return data as T;
}

/** Call an Edge Function (JSON envelope { data } | { error: { code, message, request_id } }). */
export async function callFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body, headers: { "x-request-id": crypto.randomUUID() } });
  if (error) {
    let parsed: { error?: { code?: string; message?: string } } | null = null;
    try {
      parsed = await (error as { context?: Response }).context?.json();
    } catch {
      parsed = null;
    }
    const code = parsed?.error?.code ?? "unknown";
    const base = toAppError({ message: code });
    throw new ApiError({ code, message: parsed?.error?.message && base.code === "unknown" ? parsed.error.message : base.message });
  }
  return (data as { data: T }).data;
}

/** Table query helper that throws ApiError. */
export async function must<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new ApiError(toAppError(error));
  return data as T;
}

export const newIdempotencyKey = () => crypto.randomUUID();
