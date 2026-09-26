# Plan & feasibility

Status (2026-09-24): first end-to-end prototype running on the Kaiserstuhl test area (M0–M4 in a
screening form, plus a road viewshed). See "Prototype status" at the end.

## 1. Feasibility: short answer

**Feasible.** Every data layer needed is openly available for Baden-Württemberg at high resolution.
The compute load is modest if the problem is split into a fast screening model plus a detailed model
that only runs on the top candidates. The hard part is not software. It is **how well the acoustic
predictions match reality for low-frequency sound at night**. Plan to validate with real measurements
early.

## 2. Acoustics: what matters for bass

Back-of-envelope numbers. They set the expected scale of the problem:

- **Distance alone isn't enough.** A mid-size outdoor rig might have a sound power of about
  Lw ≈ 125–130 dB in the 63 Hz octave. In free field, Lp = Lw − 20·log10(r) − 11. To get down to
  ~35 dB at 63 Hz (about the hearing threshold there) you would need **roughly 5–16 km**. Air absorbs
  almost nothing at 63 Hz (~0.1 dB/km).
- **Trees barely block bass.** ISO 9613-2 foliage attenuation at 63 Hz is ~0.02 dB/m, so 200 m of
  forest gives ~4 dB. Forest helps a lot at mid/high frequencies (and against light and sight lines),
  but hardly at all against the sub.
- **Terrain is the real shield.** Diffraction over a ridge still works at long wavelengths
  (λ ≈ 5.4 m at 63 Hz) as long as the path difference is big. A ridge that adds ~20 m of path gives
  Fresnel N ≈ 7 and roughly 20 dB of attenuation. With that, the required distance drops to about
  **1–3 km**. So the target is sites with a solid ridge between them and every settlement.
- **Night-time meteorology is the main risk.** Temperature inversions and downwind conditions bend
  sound back toward the ground. That can add 10–20 dB at km ranges and partly defeat terrain shielding.
  Valleys make this worse: cold air pools in them at night and **channels sound along the valley
  axis**. An "empty valley" is only good if its mouth doesn't open toward a village. Ridges *across*
  the line of sight help. The valley floor itself does not.
  → Always evaluate a **worst-case (favourable-propagation) scenario**, not just neutral conditions.
- **Source directivity is a lever.** Cardioid subwoofer arrays give 10–20 dB of rear rejection.
  The model can include the source's orientation, so the output could say which way to point the
  speakers.

### Model choice (two tiers)

| Tier | Model | Use |
|---|---|---|
| Screening | ISO 9613-2 (2024 revision) / CNOSSOS-EU style: octave bands 31.5–250 Hz, terrain-profile barrier diffraction, ground effect, favourable-meteo variant | All candidate × receiver pairs |
| Detailed | 2D parabolic equation (GFPE / Crank–Nicolson PE) along terrain slices with a sound-speed profile (inversion) | Top ~20 candidates, a few directions each |
| Reference | [NoiseModelling](https://github.com/Universite-Gustave-Eiffel/NoiseModelling) (open-source CNOSSOS-EU, Java) | Cross-check our screening model on a few cases |

Nord2000 is technically the best engineering model for this (it goes down to 25 Hz and handles
meteorology well), but the full spec is heavy. Consider it later if the PE/ISO split turns out too coarse.

### Receivers and annoyance

- Receivers = buildings used for living or work (LoD2 / ALKIS building function codes, plus OSM),
  weighted by estimated occupants (floor area × floors from LoD2 height).
- Thresholds: unweighted 63 Hz and 125 Hz band levels against the hearing threshold (ISO 226) and a
  typical rural night background. Also report dB(C)/dB(A) for reference (TA Lärm night limits for
  residential areas are 35–40 dB(A); DIN 45680 covers low-frequency noise).
- Noise score = Σ over receivers of occupants × f(level above threshold). Also add a hard cap:
  reject a site if **any** dwelling exceeds X dB. Isolated Black Forest farmhouses (Höfe) will be
  the binding constraint almost everywhere.

## 3. Data

LGL BW publishes these as open data (manual download; check the portal's network traffic for Atom/WFS
endpoints we could script against):

| Layer | Source | Use |
|---|---|---|
| DGM1 (1 m DTM) | LGL | terrain profiles, slope, flatness |
| DOM1 (1 m DSM) | LGL | nDSM = DSM − DTM → vegetation/obstacle height; sight lines |
| LoD2 buildings (CityGML) | LGL | receivers, building function, height |
| ALKIS land use ("tatsächliche Nutzung") | LGL | residential/commercial zones, meadow/forest/parking |
| DOP20 orthophotos | LGL | optional: NDVI-like checks, visual review of candidates |
| Roads, paths, tracks, parking, huts, campsites | OSM (Geofabrik extract) | access, "busy places", visibility sources |
| Protected areas (NSG, FFH, …) | LUBW (WFS) | hard exclusion |

Zoning plans (Bebauungspläne) are per municipality and inconsistent. ALKIS land use plus building
function covers "where people live/work" better.

**Border issue:** a 20 km radius around Freiburg crosses the Rhine near Breisach into France. LGL data
stops at the border. For French receivers use IGN open data (RGE ALTI 1 m, BD TOPO buildings) or OSM.
Alternatively, just keep candidates far enough from the border in v1.

**Data volume:** the AOI is ~1,260 km². At 1 m that's ~1.3·10⁹ cells per raster (~5 GB float32 for each
of DTM and DSM). This is fine on disk. Process it in tiles and downsample to 5–10 m for acoustics.

**Portability:** global fallback = Copernicus GLO-30 DEM, ESA WorldCover 10 m, OSM / Overture
buildings. Results will be coarser, but the pipeline stays the same.

## 4. Pipeline

1. **Ingest**: clip everything to the AOI, reproject to EPSG:25832, mosaic tiles, build a 1 m and a
   10 m raster stack.
2. **Derived layers**: nDSM, slope, a vegetation/obstacle mask, land-use classes, receiver points with
   occupant estimates.
3. **Candidates**: connected regions with nDSM < ~1 m, slope < ~5°, area > ~1,000 m² (tunable), outside
   protected areas. Summer DSM flights may show crops as "open"; use ALKIS land use to tell them apart.
   Plus OSM parking lots. Represent each region by a few source points.
4. **Access score**: network distance along OSM ways from the nearest public road/parking/transit stop.
   Bonus if a vehicle track reaches within ~X m. Reject if there's no way within ~200 m.
5. **Propagation** (screening): for each candidate, cast radial terrain profiles over the 10 m DTM out
   to ~5–8 km (numba). Compute octave-band attenuation to every receiver in range, for neutral and
   favourable-meteo cases.
6. **Hiddenness**: DSM viewshed from major roads (weighted by road class) and busy POIs to each
   candidate. Also compute the sound level the propagation model predicts at those roads/POIs.
7. **Scoring & ranking**: normalise the sub-scores, then combine with weights set in config. Hard
   constraints come first. Output a GeoPackage, a ranked CSV and a simple HTML map.
8. **Detailed check**: PE runs on the top ~20 candidates. Produce per-site noise maps and a
   recommended speaker orientation.

**Compute estimate (screening):** ~5k candidate points × ~10k receivers in range × ~500 profile
samples ≈ 10¹⁰ simple operations. With numba that's minutes to an hour on a CPU. We can prune by
distance and by line-of-sight shortcuts. No need for CUDA upfront.

## 5. Milestones

- **M0 Setup + small test tile** (~5×5 km, a valley we know): uv project, manual download of
  DGM1/DOM1/LoD2/ALKIS for that tile, OSM extract, ingest stage.
- **M1 Candidates + access**: openness mask, candidate regions, access scoring. Check them visually
  in QGIS against the orthophoto.
- **M2 Receivers**: buildings → receivers with function and occupancy.
- **M3 Screening propagation model**: ISO 9613-2-style octave-band model on terrain profiles, with
  unit tests against analytic cases, then a cross-check against NoiseModelling.
- **M4 Hiddenness + scoring + ranking**: first end-to-end result on the test tile.
- **M5 Validation**: field test with a portable subwoofer (or a sine/pink-noise sweep) and a
  calibrated SPL meter/measurement mic at a few distances behind a ridge, day and night. Calibrate
  the meteorology assumptions from the results.
- **M6 Scale-up** to the full 20 km radius: tiling, caching, profiling. Handle the French side of
  the border.
- **M7 Detailed PE model** for the top candidates + speaker orientation.
- **M8 Portability**: global-fallback adapter; run on a second region.

## 6. Decisions (2026-09-24)

- Mid-sized rig, ~100 people, omnidirectional subs (no cardioid). Lw 118/125/122/116/112 dB at 31.5–500 Hz.
- Faint sound outside is fine. Impact is judged **indoors** (tilted window) against hearing threshold
  and bedroom background.
- Runs from midnight until noon at the latest, so night-time meteorology (ISO Kmet downwind/inversion) is used.
- Some visibility is acceptable, but a spot must not be exposed. Modelled as viewsheds from major roads,
  medium (tertiary) roads and homes (upper-floor windows): people who don't hear the bass still see the lights.
- Access needs a way a car can use (track or better, no footpaths): the organisers bring the gear by car.
- Web demo name: RAVERSTUHL.

## 7. Prototype status and known limitations

- Beyond the LGL tiles (France, Freiburg side) the terrain comes from Copernicus GLO-30. That is a
  *surface* model, so forest counts as terrain and shielding is **overestimated** there. This matters
  for the spots along the Rhine.
- OSM buildings outside LoD2 coverage have no function code: `building=yes` is weighted 0.6.
- No ALKIS land use yet (vineyard vs meadow vs field). Openness comes only from nDSM height and
  roughness from a leaf-off DSM (2017/2019 flights), so fields with tall crops look open.
- Water mask comes from OSM, so it can miss small ponds or gravel-pit lakes.
- Protected areas come from OSM (NSG/nature reserves only; LSG not excluded).
- Worst-case meteorology applies to all directions at once. That's conservative: a real night has one
  wind direction.
- The propagation model is not validated against measurements yet (M5).

## 8. Open questions

- Reference sound system: sound power per band, and is cardioid sub directivity assumed?
- Acceptable impact: zero audible dwellings, or "a few, faintly"?
- Scenario: night-time only? Seasonal (leaf-on vs leaf-off, snow)?
- Minimum crowd size → minimum open area?
- Should light/laser visibility count as part of "hidden" (sky glow over ridges)?
