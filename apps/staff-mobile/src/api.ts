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

export async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new ApiError(toAppError(error));
  return data as T;
}

export const isNetworkError = (e: unknown) => e instanceof ApiError && e.code === "network";
