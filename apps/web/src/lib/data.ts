// Shared admin queries (React Query keys + fetchers).
import { useQuery } from "@tanstack/react-query";
import type { Farmer, Product, Profile } from "@kisanroute/shared";
import { supabase } from "./supabase";
import { must } from "./api";

export function useStaffList(includeInactive = false) {
  return useQuery({
    queryKey: ["staff-list", includeInactive],
    queryFn: () => {
      let q = supabase.from("profiles").select("id,display_name,email,role,status,phone,coverage_area,manager_id,last_seen_at,created_at,organization_id").order("display_name");
      if (!includeInactive) q = q.eq("status", "active").eq("role", "staff");
      return must<Profile[]>(q.limit(1000));
    },
  });
}

export function useActiveProducts() {
  return useQuery({
    queryKey: ["products-active"],
    queryFn: () => must<Product[]>(supabase.from("products").select("*").eq("active", true).order("name").limit(1000)),
  });
}

export function useFarmerOptions() {
  return useQuery({
    queryKey: ["farmer-options"],
    queryFn: () =>
      must<Pick<Farmer, "id" | "name" | "village" | "lat" | "lon" | "location_verified" | "normalized_phone">[]>(
        supabase.from("farmers").select("id,name,village,lat,lon,location_verified,normalized_phone").eq("active", true).order("name").limit(5000),
      ),
    staleTime: 60_000,
  });
}

/** Escape user text for PostgREST ilike filters inside .or() expressions. */
export const ilikeSafe = (s: string) => s.replace(/[%_,()\\*]/g, " ").trim();
