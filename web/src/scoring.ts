/** Scores and exposure, mirrored from src/geoacoustics/pipeline.py (add_scores, exposure_matrix_scores). */

import type { Meta } from './meta';

export type ScoreKey = 'noise' | 'access' | 'size' | 'hidden';
export type Weights = Record<ScoreKey, number>;

export function interp(x: number, xp: [number, number], fp: [number, number]): number {
  if (x <= xp[0]) return fp[0];
  if (x >= xp[1]) return fp[1];
  return fp[0] + ((x - xp[0]) / (xp[1] - xp[0])) * (fp[1] - fp[0]);
}

export function noiseScore(cost: number, meta: Meta): number {
  return 0.5 ** (cost / meta.impact.cost_half_people);
}

/** Needs a way a car can use (track or better): 1 up to access_full_m, 0.3 at max_vehicle_dist_m, then 0. */
export function accessScore(distVehicle: number, meta: Meta): number {
  const full = meta.candidates.access_full_m as number;
  const max = meta.candidates.max_vehicle_dist_m as number;
  return distVehicle <= max ? interp(distVehicle, [full, max], [1.0, 0.3]) : 0;
}

export function sizeScore(areaM2: number, meta: Meta): number {
  return Math.min(Math.max(areaM2 / meta.scoring.size_full_m2, 0), 1);
}

export function hiddenScore(visibleFrac: number, meta: Meta): number {
  return interp(visibleFrac, [meta.scoring.visible_ok_frac, meta.scoring.visible_bad_frac], [1.0, 0.2]);
}

/** Weighted geometric mean; ×0.25 when the loudest building is over the hard limit. */
export function combine(s: Record<ScoreKey, number>, w: Weights, feasible: boolean): number {
  let sum = 0;
  let wsum = 0;
  for (const k of Object.keys(w) as ScoreKey[]) {
    sum += w[k] * Math.log(Math.min(Math.max(s[k], 1e-9), 1));
    wsum += w[k];
  }
  const v = wsum > 0 ? Math.exp(sum / wsum) : 0;
  return feasible ? v : v * 0.25;
}

export interface Exposure {
  cost: number; // Σ weight × exposure, "people disturbed"
  audible: number; // Σ weight with excess > 0
  worst: number; // max excess over receivers (dB)
  worstIdx: number; // index into recIdx
  nAudible: number; // receiver cells with excess > 0
  /** Max-over-bands excess per receiver in recIdx order. */
  excess: Float32Array;
}

/** Same aggregation as exposure_matrix_scores, with an optional overall gain on the rig (dB). */
export function exposure(recIdx: Int32Array, recLp: Float32Array, receivers: Float32Array, meta: Meta, gainDb = 0): Exposure {
  const thr = meta.impact.thresholds_db;
  const nb = thr.length;
  const { faint_db: faint, annoying_db: annoying } = meta.impact;
  const excess = new Float32Array(recIdx.length);
  let cost = 0, audible = 0, worst = -99, worstIdx = -1, nAudible = 0;
  for (let k = 0; k < recIdx.length; k++) {
    let ex = -99;
    for (let b = 0; b < nb; b++) {
      const v = recLp[k * nb + b];
      if (!Number.isNaN(v)) ex = Math.max(ex, v + gainDb - thr[b]);
    }
    excess[k] = ex;
    const w = receivers[recIdx[k] * 4 + 2];
    if (ex > 0) {
      audible += w;
      nAudible++;
    }
    if (ex > worst) {
      worst = ex;
      worstIdx = k;
    }
    if (ex > faint) cost += w * Math.min((ex - faint) / (annoying - faint), 1);
  }
  return { cost, audible, worst, worstIdx, nAudible, excess };
}
