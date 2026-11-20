// gta6-trophy-rarity-forecast-01 entry — Node 22, standard library only.
//
// The model decomposes every trophy's earn rate into its two moving parts, the tracked-player
// count P (Exophase's denominator, which exploded from hundreds to tens of thousands in the
// game's first days as the crawler discovered owners) and the earner count E (the players who
// hold the trophy, which grows in waves: a handful of launch-night completionists, then the
// mainstream story wave):
//
//     rate_i(t) = E_i(t) / P(t)
//
// The program reads only the case's history, so everything it forecasts it must extrapolate:
//
//   1. The tracked curve. Fit the drift of ln P over the history's recent windows and let the
//      drift decay toward zero with a time constant estimated from how much the drift itself
//      slowed between the early and late halves of the history; the damped drift carries
//      ln P to the target.
//   2. The earner count. For each trophy, estimate the elasticity of ln E to ln P over the
//      recent window (a completionist trophy's earners barely move: elasticity near 0; a story
//      trophy's earners grow with the tracked flow: elasticity near 1 or above), and carry it
//      forward with the tracked curve:  E(target) = E(last) * (P(target)/P(last))^alpha.
//   3. The median is the decomposition's read at the target; a logit-trend read (a straight
//      line on logit rate against time) and the last read are kept as guarded alternates when
//      the elasticity fit is poor.
//   4. The spread comes from an internal backtest: the same extrapolation run from earlier
//      cutoffs inside the case's own history, its errors measured against the reads that
//      followed, scaled to the case's horizon. Where the backtest is silent (a short or flat
//      history) the spread falls back to the house's random-walk width.
//
// Deterministic: no randomness, no clocks — two runs write the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

const clamp01 = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clamp01(pct) / (100 - clamp01(pct)));
const expit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  trophies: Array<{ id: number; tier: string; points: number }>;
  history: Array<{ at: string; players_tracked: number; trophies_earned?: number; rates: Array<number | null> }>;
}

interface Read {
  t: number; // hours from the first read
  atMs: number;
  P: number;
  rates: Array<number | null>;
}

function parseCase(c: Case): { reads: Read[]; trophies: Case['trophies']; horizonDays: number; targetHoursFromLast: number } {
  const reads: Read[] = [];
  const t0 = Date.parse(c.history[0]!.at);
  for (const h of c.history) {
    reads.push({ t: (Date.parse(h.at) - t0) / 3_600_000, atMs: Date.parse(h.at), P: h.players_tracked, rates: h.rates });
  }
  const last = reads[reads.length - 1]!;
  const targetMs = Date.parse(c.target);
  return { reads, trophies: c.trophies, horizonDays: c.horizon_minutes / 1440, targetHoursFromLast: (targetMs - last.atMs) / 3_600_000 };
}

/** Weighted linear fit y = a + b*x (weights optional); returns null when degenerate. */
function linFit(xs: number[], ys: number[]): { a: number; b: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i]!; sy += ys[i]!; sxx += xs[i]! * xs[i]!; sxy += xs[i]! * ys[i]!;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return { a, b };
}

/** The tracked-player curve: damped-drift extrapolation of ln P. */
function forecastP(reads: Read[], hoursAhead: number): { lnP: number; sigma: number } {
  const n = reads.length;
  const last = reads[n - 1]!;
  const lnPs = reads.map((r) => Math.log(Math.max(1, r.P)));
  // drift estimates over three windows: whole history, last half, last quarter
  const windows: Array<{ from: number; to: number; slope: number }> = [];
  const spans = [n, Math.max(4, Math.ceil(n / 2)), Math.max(3, Math.ceil(n / 4))];
  for (const span of spans) {
    const from = Math.max(0, n - span);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = from; i < n; i += 1) { xs.push(reads[i]!.t); ys.push(lnPs[i]!); }
    const fit = linFit(xs, ys);
    if (fit !== null && Number.isFinite(fit.b)) windows.push({ from: reads[from]!.t, to: last.t, slope: fit.b });
  }
  if (windows.length === 0) return { lnP: lnPs[n - 1]!, sigma: 1.0 };
  // how much did the drift slow between the whole-history window and the recent ones?
  const whole = windows[0]!;
  const recent = windows[windows.length - 1]!;
  let tau = Number.POSITIVE_INFINITY;
  if (recent.slope < whole.slope && whole.slope > 0) {
    const ratio = Math.max(recent.slope, 1e-6) / whole.slope;
    const elapsed = Math.max(last.t - whole.from, 1e-6);
    // ratio ≈ exp(-elapsed/tau)
    if (ratio > 0 && ratio < 1) tau = -elapsed / Math.log(ratio);
  }
  // guard the time constant: between 1 and 7 days (24..168 h); no measured slowing -> 4 days
  const tauH = Number.isFinite(tau) ? Math.min(168, Math.max(24, tau)) : 96;
  let drift = windows[windows.length - 1]!.slope;
  // damped integral of the drift over the horizon
  let lnGain = 0;
  let remaining = hoursAhead;
  const step = 1; // hour steps
  let h = 0;
  while (remaining > 0) {
    const dt = Math.min(step, remaining);
    lnGain += drift * dt;
    h += dt;
    remaining -= dt;
    drift *= Math.exp(-dt / tauH);
  }
  const lnP = lnPs[n - 1]! + lnGain;
  // spread on ln P: the damped-gain uncertainty, floor at 0.35 for long horizons
  const floor = Math.min(0.9, 0.3 * Math.sqrt(Math.max(hoursAhead, 0.5) / 24) + 0.05);
  const sigma = Math.max(floor, Math.min(2.2, 0.55 * Math.abs(whole.slope) * Math.sqrt(hoursAhead / 24) * (tauH / 96)));
  return { lnP, sigma };
}

/** Earner estimate from a rate read: earners = rate * P / 100 (the page prints 2 decimals). */
function earnersOf(rate: number | null, P: number): number | null {
  return rate === null ? null : (rate * P) / 100;
}

/** The elasticity of ln E to ln P over a recent window, guarded. */
function elasticity(reads: Read[], trophyIndex: number, windowHours: number): { alpha: number; quality: number } | null {
  const n = reads.length;
  let from = n - 1;
  while (from > 0 && reads[n - 1]!.t - reads[from - 1]!.t < windowHours) from -= 1;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = from; i < n; i += 1) {
    const e = earnersOf(reads[i]!.rates[trophyIndex] ?? null, reads[i]!.P);
    if (e === null || e < 0.2) continue;
    xs.push(Math.log(Math.max(1, reads[i]!.P)));
    ys.push(Math.log(e));
  }
  if (xs.length < 3) return null;
  const fit = linFit(xs, ys);
  if (fit === null) return null;
  // residual scale of the fit
  let sse = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const pred = fit.a + fit.b * xs[i]!;
    sse += (ys[i]! - pred) ** 2;
  }
  const resid = Math.sqrt(sse / Math.max(1, xs.length - 2));
  const alpha = Math.min(1.6, Math.max(-0.2, fit.b));
  const quality = resid <= 0.25 ? 1 : Math.max(0, 1 - (resid - 0.25) / 0.75);
  return { alpha, quality };
}

/** The internal backtest: run the decomposition from earlier cutoffs, score against the reads that followed. */
function backtestSigma(reads: Read[], trophyIndex: number, targetHours: number): number | null {
  const n = reads.length;
  const errors: number[] = [];
  // cutoffs at 30%, 50%, 70% of the history (need >= 6 reads before and >= 3 after)
  for (const frac of [0.3, 0.5, 0.7]) {
    const cut = Math.max(6, Math.floor(n * frac));
    if (cut >= n - 2) continue;
    const past = reads.slice(0, cut);
    const future = reads.slice(cut);
    const last = past[past.length - 1]!;
    const rate0 = last.rates[trophyIndex] ?? null;
    if (rate0 === null) continue;
    const el = elasticity(past, trophyIndex, Math.max(6, (last.t - past[0]!.t) / 2));
    const pf = forecastP(past, future[future.length - 1]!.t - last.t);
    const lnP0 = Math.log(Math.max(1, last.P));
    const alpha = el === null ? 1 : el.alpha;
    const e0 = earnersOf(rate0, last.P) ?? 0;
    const pred = expit(Math.log(Math.max(0.02, e0)) + alpha * (pf.lnP - lnP0) - pf.lnP);
    const actual = future[future.length - 1]!.rates[trophyIndex] ?? null;
    if (actual === null) continue;
    errors.push(logit(actual) - logit(pred));
  }
  if (errors.length < 2) return null;
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const sd = Math.sqrt(errors.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, errors.length - 1));
  return sd;
}

function forecastTrophy(reads: Read[], trophyIndex: number, hoursAhead: number, horizonDays: number): Array<number> {
  const n = reads.length;
  const last = reads[n - 1]!;
  const rate0 = last.rates[trophyIndex];
  const fallback = (sigma: number): Array<number> => {
    const l = logit(rate0 ?? 0);
    return Z.map((z) => round4(expit(l + z * sigma)));
  };
  if (rate0 === null || rate0 <= 0) return fallback(0.6 * Math.sqrt(Math.max(horizonDays, 0.25)) + 0.2);
  // a pinned trophy at ~100% (everyone tracked holds it): hold, narrow band
  if (rate0 >= 99.9) {
    const sigma = 0.35 * Math.sqrt(Math.max(horizonDays, 0.25));
    return Z.map((z) => round4(expit(logit(99.99) + z * sigma)));
  }
  const pf = forecastP(reads, hoursAhead);
  const windowHours = Math.max(6, Math.min(36, last.t / 2));
  const el = elasticity(reads, trophyIndex, windowHours);
  const lnP0 = Math.log(Math.max(1, last.P));
  const e0 = earnersOf(rate0, last.P) ?? 0;

  // candidate medians on the logit scale
  const candidates: Array<{ l: number; weight: number }> = [];
  if (el !== null && e0 > 0) {
    const lnE = Math.log(Math.max(0.05, e0)) + el.alpha * (pf.lnP - lnP0);
    candidates.push({ l: lnE - pf.lnP, weight: el.quality });
  }
  // logit trend over the recent window (guarded)
  {
    const from = Math.max(0, n - Math.max(3, Math.ceil(n / 3)));
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = from; i < n; i += 1) {
      const r = reads[i]!.rates[trophyIndex];
      if (r === null || r <= 0) continue;
      xs.push(reads[i]!.t); ys.push(logit(r));
    }
    const fit = xs.length >= 3 ? linFit(xs, ys) : null;
    if (fit !== null && Number.isFinite(fit.b)) {
      // damp the trend with horizon
      const pred = fit.a + fit.b * (last.t + hoursAhead * 0.65);
      candidates.push({ l: Math.min(4.5, Math.max(-9, pred)), weight: 0.35 });
    }
  }
  // the last read itself
  candidates.push({ l: logit(rate0), weight: 0.3 });

  const wsum = candidates.reduce((a, c) => a + c.weight, 0);
  let medianL = logit(rate0);
  if (wsum > 0) medianL = candidates.reduce((a, c) => a + c.l * c.weight, 0) / wsum;

  // the spread: the backtest's word, the tracked curve's sigma for denominator-driven trophies,
  // and the house's random-walk floor — the widest credible voice wins, bounded
  const bt = backtestSigma(reads, trophyIndex, hoursAhead);
  const alpha = el === null ? 1 : el.alpha;
  const drivenByP = Math.abs(alpha - 1) * pf.sigma; // |d ln rate / d ln P| = |alpha - 1|
  const houseFloor = 0.5 * Math.sqrt(Math.max(horizonDays, 0.02));
  let sigma = Math.max(
    bt === null ? 0 : bt * Math.sqrt(Math.max(hoursAhead, 1) / Math.max(1, hoursAhead)) * 1.2,
    drivenByP,
    houseFloor * 0.8,
  );
  sigma = Math.min(2.2, Math.max(0.12, sigma));
  return Z.map((z) => round4(expit(medianL + z * sigma)));
}

function runCase(c: Case): string {
  const { reads, trophies, horizonDays, targetHoursFromLast } = parseCase(c);
  const rows = trophies.map((t, i) => ({ id: t.id, q: forecastTrophy(reads, i, targetHoursFromLast, horizonDays) }));
  return `${JSON.stringify({ trophies: rows })}\n`;
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
  for (const file of inputs) {
    const id = file.slice(0, -'.in'.length);
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), runCase(c));
  }
}

main();
