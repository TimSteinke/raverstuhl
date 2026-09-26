/** Types for web/public/data/<name>/meta.json (written by src/geoacoustics/webexport.py). */

export type LngLat = [number, number];

export interface GridMeta {
  xmin: number;
  ymax: number;
  res: number;
  rows: number;
  cols: number;
  /** Top-left, top-right, bottom-right, bottom-left as [lon, lat]. */
  corners: [LngLat, LngLat, LngLat, LngLat];
}

export interface TopSite {
  rank: number;
  cand_id: number;
  score: number;
  lon: number;
  lat: number;
  area_m2: number;
  noise_cost: number;
  feasible: boolean;
}

export interface Meta {
  name: string;
  crs: string;
  proj4: string;
  core_bounds: [number, number, number, number];
  model: {
    bands_hz: number[];
    lw_db: number[];
    alpha_db_km: number[];
    fol_fixed: number[];
    fol_per_m: number[];
    ground_g: [number, number, number];
    iso_idx: number[];
    use_kmet: boolean;
    step_m: number;
    source_h_m: number;
    receiver_h_m: number;
    max_range_m: number;
  };
  impact: {
    facade_reduction_db: number[];
    hearing_threshold_db: number[];
    indoor_background_db: number[];
    rhythm_detect_db: number;
    faint_db: number;
    annoying_db: number;
    max_worst_db: number;
    cost_half_people: number;
    thresholds_db: number[];
  };
  scoring: {
    heatmap_res_m: number;
    weights: Record<'noise' | 'access' | 'size' | 'hidden', number>;
    size_full_m2: number;
    visible_ok_frac: number;
    visible_bad_frac: number;
    site_merge_m: number;
  };
  visibility: {
    observers: Record<string, { classes?: string[]; spacing_m?: number; cell_m?: number; eye_height_m: number; skip_obstacles_m?: number }>;
    res_m: number;
    target_height_m: number;
    min_obstacle_m: number;
    max_range_m: number;
  };
  candidates: Record<string, number | boolean>;
  display: GridMeta & { layers: Record<string, { dtype: 'u8' | 'u16'; scale: number; url: string }> };
  visibility_image: GridMeta & { url: string };
  /** Bit k of the seen_by layer = visible from observer class seen_by_classes[k]. */
  seen_by_classes: string[];
  heat: GridMeta & { urls: Record<'cost' | 'audible' | 'worst', string> };
  terrain: GridMeta & {
    chunk: number;
    chunk_rows: number;
    chunk_cols: number;
    terrain_scale: number;
    canopy_scale: number;
    nodata: number;
    url: string;
  };
  receivers: { url: string; count: number; stride: number; origin: [number, number]; near_field_m: number };
  dem: { url: string; encoding: 'terrarium'; minzoom: number; maxzoom: number; bounds: [number, number, number, number] };
  /** Files loaded before the map starts → uncompressed size in bytes (for the progress bar). */
  initial_files?: Record<string, number>;
  top_sites: TopSite[];
  stats: {
    candidates: number;
    sites: number;
    feasible_sites: number;
    buildings: number;
    buildings_lod2: number;
    occupied_buildings: number;
    people_eq: number;
    receiver_cells: number;
    heat_points: number;
  };
}
