import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Meta } from './meta';
import { accessScore, combine, hiddenScore, noiseScore, sizeScore } from './scoring';

const DATA = new URL('../public/data/', import.meta.url).pathname;
const AREA = existsSync(DATA + 'areas.json') ? JSON.parse(readFileSync(DATA + 'areas.json', 'utf8'))[0]?.name : undefined;
const DIR = `${DATA}${AREA}/`;

describe.skipIf(!existsSync(DIR + 'meta.json'))('TS scoring matches pipeline.add_scores', () => {
  const meta: Meta = JSON.parse(readFileSync(DIR + 'meta.json', 'utf8'));
  const fc = JSON.parse(readFileSync(DIR + 'candidates.geojson', 'utf8'));

  it(`reproduces the scores of ${fc.features.length} candidates`, () => {
    let worst = 0;
    for (const f of fc.features) {
      const p = f.properties;
      const s = {
        noise: noiseScore(p.noise_cost, meta),
        access: accessScore(p.dist_vehicle_m, meta),
        size: sizeScore(p.area_m2, meta),
        hidden: hiddenScore(p.visible_frac ?? 0, meta),
      };
      const score = combine(s, meta.scoring.weights, p.worst_excess_db <= meta.impact.max_worst_db);
      worst = Math.max(worst, Math.abs(score - p.score));
    }
    expect(worst).toBeLessThan(2e-3); // properties are rounded to 4 decimals in the export
  });
});
