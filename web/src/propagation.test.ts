import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Meta } from './meta';
import { makeScratch, pathLevels } from './propagation';
import { TerrainStore, modelFromMeta } from './terrain';

const DATA = new URL('../public/data/', import.meta.url).pathname;
const AREA = existsSync(DATA + 'areas.json') ? JSON.parse(readFileSync(DATA + 'areas.json', 'utf8'))[0]?.name : undefined;
const DIR = `${DATA}${AREA}/`;

describe.skipIf(!existsSync(DIR + 'meta.json'))('TS propagation port matches the numba kernel', () => {
  const meta: Meta = JSON.parse(readFileSync(DIR + 'meta.json', 'utf8'));
  const cases: { s: [number, number]; r: [number, number]; lp: number[] }[] = JSON.parse(
    readFileSync(DIR + 'test_vectors.json', 'utf8'),
  );
  const store = new TerrainStore(meta, async (i, j) => {
    const p = `${DIR}terrain/${i}_${j}.bin`;
    if (!existsSync(p)) return null;
    const b = readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  });
  const model = modelFromMeta(meta);
  const scratch = makeScratch(model);

  it(`reproduces ${cases.length} exported source–receiver pairs (max |Δ| < 1e-4 dB)`, async () => {
    let worst = 0;
    for (const c of cases) {
      const { terrain, canopy } = await store.window(c.s[0], c.s[1], model.maxRangeM + 200);
      const out = new Float64Array(model.freqs.length);
      pathLevels(terrain, canopy, model, c.s[0], c.s[1], c.r[0], c.r[1], out, scratch);
      for (let b = 0; b < out.length; b++) worst = Math.max(worst, Math.abs(out[b] - c.lp[b]));
    }
    console.log(`max |Δ| = ${worst.toExponential(2)} dB`);
    expect(worst).toBeLessThan(1e-4);
  }, 120_000);
});
