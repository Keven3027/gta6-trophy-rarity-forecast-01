// backtest.ts — synthetic-dynamics validation for the forecast model.
//
// The practice cases' histories are flat (launch night, before the tracked explosion), so they
// cannot validate a trend model. This generator builds cases with the dynamics the live page
// showed between 19 and 21 November 2026: a tracked count growing from hundreds to tens of
// thousands, a launch-night completionist cohort whose earner counts barely move, and a
// mainstream story wave whose earner counts ride the tracked flow. The model, the house
// baseline and the house curve baseline are scored on the same synthetic answer with the
// contest's pinball loss on the logit scale.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const clamp01 = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clamp01(pct) / (100 - clamp01(pct)));
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

interface Trophy { id: number; name: string; tier: string; points: number; secret: boolean }
interface Read { slot: number; at: string; players_tracked: number; trophies_earned: number; rates: Array<number | null> }
interface Case { id: string; at: string; horizon_minutes: number; target: string; levels: number[]; trophies: Trophy[]; history: Read[] }

// deterministic pseudo-random (LCG) so runs are byte-stable
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Tracked-player curves: three scenarios for how fast Exophase's crawler found owners. */
function trackedAt(hoursFromStart: number, scenario: 'fast' | 'mid' | 'slow'): number {
  // all curves pass (2.2h, 638) and (68.9h, 44161); they differ in later decay
  const base = (h: number, k: number): number => {
    // logistic-ish: exponential growth with rate decaying exponentially, time constant tau
    const tau = k; // hours
    const a = 0.065; // instantaneous drift of ln P at t=0 (per hour)
    // integral: gain(t) = a*tau*(1 - exp(-t/tau)); anchor: gain(2.2) then gain(68.9) hits 44161
    const gain = (t2: number): number => a * tau * (1 - Math.exp(-t2 / tau));
    const G0 = Math.log(638) - gain(2.2);
    return Math.exp(G0 + gain(h));
  };
  const p = base(hoursFromStart, scenario === 'fast' ? 40 : scenario === 'mid' ? 30 : 24);
  return Math.max(638, p);
}

interface TrophySpec {
  // earners(t) = completists + wave
  completists: number;      // launch-night players who hold it from hour ~2
  waveRate: number;         // share of new tracked players who eventually earn it (0..1)
  waveLagH: number;         // hours of play before a new player reaches it
  waveSpreadH: number;      // spread of the reach time
}

function earnerCount(t: number, spec: TrophySpec, P: number, rnd: () => number): number {
  const completists = spec.completists;
  // the wave: new players arrive ∝ dP; each earns the trophy when play-time passes the lag
  // approximate the reached share with a smooth logistic on (t - lag)
  const wave = spec.waveRate > 0
    ? spec.waveRate * P / (1 + Math.exp(-(t - spec.waveLagH) / Math.max(2, spec.waveSpreadH)))
    : 0;
  const noise = spec.completists > 0 ? 0 : Math.round(rnd() * 0.4);
  return Math.max(0, completists + wave + noise);
}

const SPECS: TrophySpec[] = [
  // id 1 platinum
  { completists: 4, waveRate: 0.0, waveLagH: 0, waveSpreadH: 1 },
  // id 2 the everyone trophy
  { completists: 638, waveRate: 1.0, waveLagH: -50, waveSpreadH: 1 },
  // id 3 chapter 1
  { completists: 8, waveRate: 0.16, waveLagH: 8, waveSpreadH: 14 },
  // id 4 chapter 2
  { completists: 7, waveRate: 0.03, waveLagH: 14, waveSpreadH: 16 },
  // ids 5..13 late chapters: completionists only
  ...Array.from({ length: 9 }, () => ({ completists: 7, waveRate: 0.0002, waveLagH: 40, waveSpreadH: 20 })),
  // ids 14..19 hard challenges
  ...Array.from({ length: 6 }, (_, i) => ({ completists: 5 + (i % 2), waveRate: 0.0001, waveLagH: 50, waveSpreadH: 30 })),
  // id 20 fishing minigame (popular)
  { completists: 13, waveRate: 0.15, waveLagH: 20, waveSpreadH: 18 },
  // id 21 arcade
  { completists: 6, waveRate: 0.02, waveLagH: 16, waveSpreadH: 16 },
  // ids 22..31 rare
  ...Array.from({ length: 10 }, (_, i) => ({ completists: 5 + (i % 2), waveRate: 0.0001, waveLagH: 50, waveSpreadH: 30 })),
  // id 32 finish 50 challenges
  { completists: 4, waveRate: 0.003, waveLagH: 35, waveSpreadH: 22 },
  // id 33 hot together
  { completists: 6, waveRate: 0.0005, waveLagH: 45, waveSpreadH: 25 },
  // id 34 discover 100 vehicles
  { completists: 5, waveRate: 0.02, waveLagH: 18, waveSpreadH: 16 },
  // id 35 gunslinger
  { completists: 5, waveRate: 0.002, waveLagH: 12, waveSpreadH: 12 },
  // id 36 catch me if you can
  { completists: 6, waveRate: 0.005, waveLagH: 20, waveSpreadH: 15 },
  // id 37 tank
  { completists: 10, waveRate: 0.004, waveLagH: 22, waveSpreadH: 15 },
  // ids 38..43 rare
  ...Array.from({ length: 6 }, (_, i) => ({ completists: 5 + (i % 2), waveRate: 0.0002, waveLagH: 48, waveSpreadH: 25 })),
  // id 44 in the beginning
  { completists: 6, waveRate: 0.015, waveLagH: 4, waveSpreadH: 10 },
  // ids 45..47 rare
  ...Array.from({ length: 3 }, () => ({ completists: 5, waveRate: 0.0002, waveLagH: 48, waveSpreadH: 25 })),
  // id 48 bowling story
  { completists: 5, waveRate: 0.008, waveLagH: 26, waveSpreadH: 18 },
  // id 49 bad luck
  { completists: 5, waveRate: 0.0007, waveLagH: 30, waveSpreadH: 20 },
  // id 50 truth is out there
  { completists: 5, waveRate: 0.0008, waveLagH: 34, waveSpreadH: 22 },
  // ids 51..55 rare
  ...Array.from({ length: 5 }, () => ({ completists: 5, waveRate: 0.0002, waveLagH: 48, waveSpreadH: 25 })),
];

function buildSyntheticCase(id: string, checkpointH: number, horizonH: number, scenario: 'fast' | 'mid' | 'slow', seed: number): Case {
  const rnd = lcg(seed);
  const trophies: Trophy[] = SPECS.map((_, i) => ({
    id: i + 1,
    name: `trophy-${i + 1}`,
    tier: i === 0 ? 'platinum' : 'bronze',
    points: i === 0 ? 300 : 15,
    secret: i !== 0 && i % 3 !== 0,
  }));
  // reads every 30 min until checkpoint, oldest first
  const reads: Read[] = [];
  let slot = 0;
  for (let h = 0; h <= checkpointH + 1e-9; h += 0.5) {
    const P = Math.round(trackedAt(h, scenario));
    const rates = SPECS.map((spec) => {
      const e = earnerCount(h, spec, P, rnd);
      const rate = (e / P) * 100;
      // the page prints 2 decimals
      return Math.round(rate * 100) / 100;
    });
    const trophiesEarned = Math.round(rates.reduce((a, r) => a + r, 0) * P / 100);
    reads.push({ slot, at: new Date(Date.UTC(2026, 10, 18, 23, 50) + h * 3600_000).toISOString(), players_tracked: P, trophies_earned: trophiesEarned, rates });
    slot += 1;
  }
  const last = reads[reads.length - 1]!;
  return {
    id,
    at: last.at,
    horizon_minutes: Math.round(horizonH * 60),
    target: new Date(Date.parse(last.at) + horizonH * 3600_000).toISOString(),
    levels: LEVELS,
    trophies,
    history: reads,
  };
}

// ---- the two baselines ----

function houseBaseline(c: Case): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const last = c.history[c.history.length - 1]!;
  const d = c.horizon_minutes / 1440;
  c.trophies.forEach((t, i) => {
    const l = logit(last.rates[i] ?? 0);
    out.set(t.id, Z.map((z) => Math.round(100 / (1 + Math.exp(-(l + z * 0.5 * Math.sqrt(d)))) * 10_000) / 10_000));
  });
  return out;
}

function houseCurveBaseline(c: Case): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const lastRead = c.history[c.history.length - 1]!;
  const targetMs = Date.parse(c.target);
  const d = c.horizon_minutes / 1440;
  c.trophies.forEach((t, i) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of c.history) {
      if (Date.parse(r.at) < Date.parse(lastRead.at) - 24 * 3600_000) continue;
      const rate = r.rates[i];
      if (rate === null || rate <= 0) continue;
      xs.push(Math.log(1 + (Date.parse(r.at) - Date.UTC(2026, 10, 19)) / 3600_000));
      ys.push(logit(rate));
    }
    const n = xs.length;
    let median = logit(lastRead.rates[i] ?? 0);
    let resid = 0;
    if (n >= 3) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let k = 0; k < n; k += 1) { sx += xs[k]!; sy += ys[k]!; sxx += xs[k]! * xs[k]!; sxy += xs[k]! * ys[k]!; }
      const den = n * sxx - sx * sx;
      if (Math.abs(den) > 1e-12) {
        const b = (n * sxy - sx * sy) / den;
        const a = (sy - b * sx) / n;
        median = a + b * Math.log(1 + (targetMs - Date.UTC(2026, 10, 19)) / 3600_000);
        for (let k = 0; k < n; k += 1) resid += (ys[k]! - (a + b * xs[k]!)) ** 2;
        resid = Math.sqrt(resid / Math.max(1, n - 2));
      }
    }
    const sigma = Math.sqrt((0.5 * Math.sqrt(d)) ** 2 + resid ** 2);
    out.set(t.id, Z.map((z) => Math.round(100 / (1 + Math.exp(-(median + z * sigma))) * 10_000) / 10_000));
  });
  return out;
}

// ---- the entry under test ----

async function entryForecast(caseFile: string, outDir: string): Promise<Map<number, number[]>> {
  const { execFileSync } = await import('node:child_process');
  execFileSync('/root/makefun/node-v22.22.0-linux-x64/bin/node', ['main.ts'], {
    cwd: '/root/makefun/work-forecast',
    env: { ...process.env, MAKEFUN_INPUT_DIR: caseFile, MAKEFUN_OUTPUT_DIR: outDir },
    stdio: 'pipe',
  });
  const files = readdirSync(outDir).filter((f) => f.endsWith('.out'));
  const result = new Map<number, number[]>();
  for (const f of files) {
    const parsed = JSON.parse(readFileSync(join(outDir, f), 'utf8')) as { trophies: Array<{ id: number; q: number[] }> };
    for (const row of parsed.trophies) result.set(row.id, row.q);
  }
  return result;
}

function pinballLoss(c: Case, forecast: Map<number, number[]>): number {
  const answer = c.history[c.history.length - 1]!; // for synthetic cases the answer is the target read
  let total = 0;
  let items = 0;
  for (const [ti, t] of c.trophies.entries()) {
    const y = answer.rates[ti] ?? 0;
    const q = forecast.get(t.id);
    if (q === undefined) throw new Error(`no forecast row for ${t.id}`);
    for (let k = 0; k < 5; k += 1) {
      const d = logit(y) - logit(q[k]!);
      const tau = LEVELS[k]!;
      total += 2 * Math.max(tau * d, (tau - 1) * d);
      items += 1;
    }
  }
  return total / items;
}

async function main(): Promise<void> {
  const scenarios: Array<{ name: string; scenario: 'fast' | 'mid' | 'slow'; horizonH: number; targetH: number }> = [
    { name: 'syn-fast', scenario: 'fast', horizonH: 110, targetH: 145 },
    { name: 'syn-mid', scenario: 'mid', horizonH: 110, targetH: 145 },
    { name: 'syn-slow', scenario: 'slow', horizonH: 110, targetH: 145 },
    { name: 'syn-short', scenario: 'mid', horizonH: 1.5, targetH: 8 },
  ];
  for (const s of scenarios) {
    const c = buildSyntheticCase(s.name, s.targetH, s.horizonH, s.scenario, 42);
    // write the case for the entry
    const inDir = `/tmp/syn-${s.name}`;
    mkdirSync(inDir, { recursive: true });
    writeFileSync(join(inDir, `${s.name}.in`), JSON.stringify(c));
    const outDir = `/tmp/syn-${s.name}-out`;
    mkdirSync(outDir, { recursive: true });
    const mine = await entryForecast(inDir, outDir);
    const house = houseBaseline(c);
    const curve = houseCurveBaseline(c);
    const lm = pinballLoss(c, mine);
    const lh = pinballLoss(c, house);
    const lc = pinballLoss(c, curve);
    console.log(`${s.name}: entry=${lm.toFixed(4)}  house=${lh.toFixed(4)}  curve=${lc.toFixed(4)}  ${lm < lh ? 'BEATS house' : 'loses to house'}${lm < lc ? ', beats curve' : ', loses to curve'}`);
    // a peek at three rows
    for (const id of [1, 3, 6]) {
      const P = c.history[c.history.length - 1]!.players_tracked;
      const r = c.history[c.history.length - 1]!.rates[id - 1];
      console.log(`  trophy ${id}: last rate ${r?.toFixed(2)}% (P=${P}), q=${JSON.stringify(mine.get(id))}`);
    }
  }
}

main();
