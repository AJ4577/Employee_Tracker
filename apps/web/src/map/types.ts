import type { ReactNode } from "react";

export interface MapMarker {
  id: string;
  lat: number;
  lon: number;
  label: string;
  kind: "farmer" | "farmer-approx" | "staff-live" | "staff-stale" | "staff-last" | "search" | "me" | "pick" | "stop" | "vehicle" | "start" | "end";
  /** Short text drawn on the marker, e.g. a stop number. */
  badge?: string;
  accuracy_m?: number | null;
  popup?: ReactNode;
}

export interface LocalSearchResult {
  id: string;
  label: string;
  sub?: string;
  lat: number;
  lon: number;
}

export interface MapProps {
  markers?: MapMarker[];
  /**
   * Actual GPS breadcrumbs only (accepted device points), as separate segments. Segments are
   * never joined, so trips and offline gaps don't produce invented straight lines.
   */
  routes?: [number, number][][];
  center?: [number, number] | null;
  zoom?: number;
  height?: number | string;
  onPick?: (lat: number, lon: number) => void;
  localSearch?: (q: string) => LocalSearchResult[];
  searchable?: boolean;
  title?: string;
  legend?: ReactNode;
  /** Connectors across periods with no GPS data; drawn dotted grey and never as a travelled road. */
  gapLines?: [number, number][][];
  /** When set, the map only re-fits when this changes (e.g. during playback a moving marker must not refit). */
  fitKey?: string;
}
