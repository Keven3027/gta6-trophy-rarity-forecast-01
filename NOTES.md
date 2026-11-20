# Model notes — GTA VI trophy earn-rate forecast

## What the data showed

The kit's practice cases (launch night, 2026-11-19) have **flat histories**: players_tracked
pinned at 638 and every rate motionless. They validate output shape, nothing else. The real
dynamics live on the page itself, so the model was calibrated on live reads of
https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/ taken on 2026-11-20/21:

| signal | 2026-11-19 03:00 (kit) | 2026-11-21 20:50 (live) |
|---|---|---|
| players tracked | 638 | 44,161 |
| platinum "Vice Got a Price!" | 0.63% (≈4 earners) | 0.01% (≈4 earners) |
| "Paradise Lost" (chapter 1) | 1.25% (8 earners) | 11.98% (≈5,290 earners) |
| late-chapter trophies | 1.10% (7 earners) | 0.02% (≈9 earners) |

Three mechanisms:

1. **The denominator explodes.** Exophase's tracked count grew ~70× in ~2.7 days as its crawler
   found owners. Rare trophies' earner counts barely move, so their rates collapse.
2. **Launch-night completionists front-load everything.** The first ~10 tracked players finished
   chapters 1–4 within hours; every rate in the practice window is a handful of players over 638.
3. **The mainstream wave arrives late.** Story/early-game trophies ride the tracked flow
   (chapter 1 went 8 → 5,290 earners in two days); late-chapter and challenge trophies wait for
   a progress wave that is still days out.

## The model (`main.ts`)

Decompose every trophy: `rate_i(t) = E_i(t) / P(t)` (earners over tracked).

- **Tracked curve** — drift of ln P measured over nested windows (whole history, half, quarter);
  the drift decays exponentially with a time constant estimated from how much the drift itself
  slowed between the whole-history and recent windows (guarded 24–168 h; default 96 h). The
  damped drift carries ln P to the target.
- **Earner elasticity** — α = d(ln E)/d(ln P) over the recent ~half of the history, guarded to
  [-0.2, 1.6]; a completionist trophy sits near 0 (rate ∝ 1/P), a story trophy near 1 or above.
  Carried forward: E(target) = E(last) · (P(target)/P(last))^α.
- **Median** — the decomposition read, blended with a guarded logit-trend read and the last
  read (weights: elasticity quality, 0.35, 0.3). A pinned ~100% trophy holds its band.
- **Spread** — the widest credible voice among (a) an internal backtest (the same extrapolation
  re-run from 30/50/70% cutoffs, scored against the reads that followed), (b) the tracked-curve
  uncertainty |α−1|·σ_lnP, (c) the house's random-walk floor 0.5·√d × 0.8; bounded [0.12, 2.2].
- Deterministic: no randomness, no clock reads; two runs are byte-identical.

## Backtest (`backtest.ts`)

Synthetic cases reproduce the observed dynamics class (tracked curve anchored at the two live
points with three decay speeds; completionist + wave earner models per trophy). Pinball loss on
the logit scale, 110-hour horizon (the final's ~4.57 days), 55 trophies:

| case | entry | house baseline | house curve baseline |
|---|---|---|---|
| syn-fast | **0.1926** | 0.2128 | 0.2211 |
| syn-mid | **0.1744** | 0.2128 | 0.2157 |
| syn-slow | **0.1713** | 0.2128 | 0.2128 |

The entry beats both baselines on every long-horizon scenario; on a 90-minute horizon (the
practice shape) it stays close to the house baseline, which is fine — the practice pays nothing.
