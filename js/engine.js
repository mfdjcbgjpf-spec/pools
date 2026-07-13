// ============================================================================
// engine.js — BTTS / Classic Pools prediction engine
// Ported 1:1 from 02_ENGINE_v3.py (Vincent Ho Kam, consolidated 13 July 2026)
//
// Pipeline:
//   venue-split rates -> Bayesian shrinkage -> attack/defence -> lambdas
//   -> Dixon-Coles 9x9 matrix -> P(BTTS) / P(score draw) / P(0-0) / win probs
//   -> humility blend toward league base (BTTS) / GAP-XG-00-RUNAWAY (Pools)
//   -> filters -> slip maths (Poisson-binomial + correlated Monte Carlo)
//
// CORE PRINCIPLE (BTTS): the away side's away scoring rate is the binding
// constraint. CORE PRINCIPLE (Classic Pools): moderate, roughly-equal lambdas
// produce score draws; suppressed lambdas give 0-0, not 1-1/2-2.
// ============================================================================

const MATRIX_SIZE = 9;

/** Poisson pmf, k successes given rate lam. */
function pois(k, lam) {
  return Math.exp(-lam) * Math.pow(lam, k) / factorial(k);
}

function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/** Dixon-Coles corrected, normalised 9x9 score matrix. */
function dcMatrix(lh, la, rho, size = MATRIX_SIZE) {
  const M = [];
  for (let i = 0; i < size; i++) {
    const row = [];
    for (let j = 0; j < size; j++) row.push(pois(i, lh) * pois(j, la));
    M.push(row);
  }
  M[0][0] *= (1 - lh * la * rho);
  M[0][1] *= (1 + lh * rho);
  M[1][0] *= (1 + la * rho);
  M[1][1] *= (1 - rho);

  let total = 0;
  for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) total += M[i][j];
  for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) M[i][j] /= total;
  return M;
}

/** Bayesian shrinkage of an observed rate x (n matches) toward a league prior. */
function shrink(x, prior, n, k) {
  return (n * x + k * prior) / (n + k);
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

// ----------------------------------------------------------------------
// SHARED MODEL — venue-split lambdas + full score-matrix read-out.
// Both BTTS and Classic Pools evaluators build on this single calculation,
// so venue effects (home GF/GA at home, away GF/GA away) are captured once,
// not double-applied.
// ----------------------------------------------------------------------
function computeModel(m, league, settings) {
  const L = league;
  const n = Math.max(1, m.n || 1);
  const k = settings.k;

  const hgf = shrink(m.hgf, L.hg, n, k);
  const hga = shrink(m.hga, L.ag, n, k);
  const agf = shrink(m.agf, L.ag, n, k);
  const aga = shrink(m.aga, L.hg, n, k);

  const hAtt = hgf / L.hg, hDef = hga / L.ag;
  const aAtt = agf / L.ag, aDef = aga / L.hg;

  const lh = clamp(hAtt * aDef * L.hg, 0.15, 4.5);
  const la = clamp(aAtt * hDef * L.ag, 0.10, 4.5);

  const M = dcMatrix(lh, la, settings.rho);
  const size = M.length;

  let p_btts = 0, p_home_blank = 0, p_away_blank = 0;
  let p_00 = 0, p_score_draw = 0;
  let p_home_win = 0, p_away_win = 0, p_draw = 0;
  const p_11 = M[1][1], p_22 = M[2][2];

  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const p = M[i][j];
      if (i > 0 && j > 0) p_btts += p;
      if (i === 0) p_home_blank += p;
      if (j === 0) p_away_blank += p;
      if (i === j) { if (i === 0) p_00 += p; else p_score_draw += p; }
      if (i > j) p_home_win += p;
      else if (j > i) p_away_win += p;
      else p_draw += p;
    }
  }

  return {
    lh, la, M,
    p_btts, p_home_blank, p_away_blank,
    p_00, p_score_draw, p_11, p_22,
    pools_green: p_11 + p_22,
    p_home_win, p_away_win, p_draw,
    raw_agf: m.agf, raw_hgf: m.hgf,
  };
}

// ----------------------------------------------------------------------
// BTTS EVALUATOR — zero-blend, humility blend, delta, AWAY/BLOWOUT/F1/F2/F3
// ----------------------------------------------------------------------
function evaluateBTTS(m, league, settings) {
  if (league.delta === null || league.delta === undefined) {
    return {
      fixture: `${m.home} v ${m.away}`, league: m.league,
      drop: true, reason: 'League on systematic AVOID list',
      P: 0, lh: null, la: null, flags: [['avoid', 'AVOID league']],
    };
  }

  const n = Math.max(1, m.n || 1);
  const model = computeModel(m, league, settings);
  let { lh, la, p_home_blank } = model;
  let p_away_blank = model.p_away_blank;
  let p_btts = model.p_btts;

  // --- Zero-blend correction (F1 fix) ------------------------------
  if (m.fts_away !== undefined && m.fts_away !== null &&
      m.cs_home !== undefined && m.cs_home !== null) {
    const w0 = n / (n + 6.0);
    const empZero = (m.fts_away + m.cs_home) / 2.0;
    p_away_blank = w0 * p_away_blank + (1 - w0) * empZero;
    p_btts = (1 - p_home_blank) * (1 - p_away_blank);
  }

  // --- Humility blend toward league base ---------------------------
  const w = settings.w;
  let P = (1 - w) * p_btts + w * league.base;

  // --- League calibration offset ------------------------------------
  P += league.delta * 0.5;

  // ================== FILTERS ========================================
  const flags = [];
  let drop = false;
  const rawAgf = m.agf;

  if (rawAgf < 0.80) {
    P *= 0.55;
    flags.push(['away', 'Away GF < 0.80 — DROP']);
    drop = true;
  } else if (rawAgf < 1.00) {
    P *= 0.75;
    flags.push(['away', 'Away GF < 1.00 — gated']);
  }

  if (lh > 2.30 && la < 1.00) {
    P *= 0.88;
    flags.push(['blow', 'Blowout risk']);
  }

  if (p_away_blank > 0.40) {
    flags.push(['f1', 'F1 clean-sheet risk']);
    drop = true;
  }

  if (m.runaway) {
    P *= 0.80;
    flags.push(['f2', 'F2 runaway leader']);
    drop = true;
  }

  if (lh + la < 2.20) {
    flags.push(['f3', 'F3 low-scoring pair']);
    drop = true;
  }

  P = clamp(P, 0.02, 0.97);

  return {
    fixture: `${m.home} v ${m.away}`,
    home: m.home, away: m.away,
    league: m.league,
    lh: round(lh, 2), la: round(la, 2),
    P: round(P, 4),
    p_away_blank: round(p_away_blank, 3),
    p_11: round(model.p_11, 4), p_22: round(model.p_22, 4),
    p_00: round(model.p_00, 4), p_score_draw: round(model.p_score_draw, 4),
    pools_green: round(model.pools_green, 4),
    flags, drop,
    safe: P >= settings.safe && !drop,
  };
}

// ----------------------------------------------------------------------
// CLASSIC POOLS EVALUATOR — GAP / XG / 00 / RUNAWAY, F3 inversion
// Target metric: score = P(1-1) + P(2-2)
// ----------------------------------------------------------------------
function evaluateClassicPools(m, league, settings) {
  const model = computeModel(m, league, settings);
  const { lh, la, p_00, p_score_draw, p_home_win, p_away_win, p_draw } = model;
  const score = model.pools_green; // P(1-1) + P(2-2)
  const combinedXG = lh + la;
  const favourite = Math.max(p_home_win, p_away_win);

  const flags = [];
  let drop = false;

  // GAP — mismatch gives a comfortable win or a backs-to-the-wall clean sheet
  if (favourite > settings.poolsGapThreshold) {
    flags.push(['gap', `GAP — favourite win prob ${(favourite * 100).toFixed(0)}% > ${(settings.poolsGapThreshold * 100).toFixed(0)}%`]);
    drop = true;
  }

  // XG — combined expected goals outside the 2.0-2.6 window
  if (combinedXG < settings.poolsXgLow || combinedXG > settings.poolsXgHigh) {
    flags.push(['xg', `XG — combined xG ${combinedXG.toFixed(2)} outside ${settings.poolsXgLow}-${settings.poolsXgHigh}`]);
    drop = true;
  }

  // 00 — 0-0 / RED risk too high (F3 INVERTED: suppressed lambdas hurt GREEN)
  if (p_00 > settings.poolsZeroZeroRisk) {
    flags.push(['00', `0-0 risk ${(p_00 * 100).toFixed(1)}% > ${(settings.poolsZeroZeroRisk * 100).toFixed(0)}%`]);
    drop = true;
  }

  // RUNAWAY — same logic as BTTS F2
  if (m.runaway) {
    flags.push(['runaway', 'RUNAWAY league leader involved']);
    drop = true;
  }

  return {
    fixture: `${m.home} v ${m.away}`,
    home: m.home, away: m.away,
    league: m.league,
    lh: round(lh, 2), la: round(la, 2),
    combinedXG: round(combinedXG, 2),
    score: round(score, 4),          // P(1-1) + P(2-2) — rank on this
    p_00: round(p_00, 4),
    p_score_draw_total: round(p_score_draw, 4),
    p_home_win: round(p_home_win, 4),
    p_away_win: round(p_away_win, 4),
    p_draw: round(p_draw, 4),
    favourite: round(favourite, 4),
    flags, drop,
    safe: score >= settings.poolsSafeThreshold && !drop,
  };
}

// ----------------------------------------------------------------------
// SLIP MATHS — exact Poisson-binomial distribution of hit-count
// ----------------------------------------------------------------------
function poissonBinomial(ps) {
  let d = [1.0];
  for (const p of ps) {
    const nd = new Array(d.length + 1).fill(0);
    for (let i = 0; i < d.length; i++) {
      nd[i] += d[i] * (1 - p);
      nd[i + 1] += d[i] * p;
    }
    d = nd;
  }
  return d;
}

/** Mulberry32 seeded PRNG (deterministic runs on demand; reseed for variety). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand, mean, sd) {
  // Box-Muller
  const u1 = Math.max(rand(), 1e-12), u2 = rand();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * sd;
}

/**
 * Monte Carlo with a shared per-league goal-environment factor gamma.
 * legs = [{P, league}]. Punishes stacking multiple legs in one league.
 */
function correlatedMC(legs, settings, seed) {
  const iters = settings.mcIter;
  const sd = settings.gammaSd;
  const rand = mulberry32(seed ?? 42);
  const leagues = [...new Set(legs.map(l => l.league))];
  const counts = new Array(legs.length + 1).fill(0);

  for (let it = 0; it < iters; it++) {
    const gamma = {};
    for (const lg of leagues) gamma[lg] = gaussian(rand, 1.0, sd);
    let hits = 0;
    for (const { P, league } of legs) {
      const pAdj = clamp(P * gamma[league], 0.01, 0.99);
      if (rand() < pAdj) hits++;
    }
    counts[hits]++;
  }
  return counts.map(c => c / iters);
}

/** legs = [{name, P, league}] */
function slipReport(legs, settings) {
  const ps = legs.map(l => l.P);
  const n = ps.length;
  const ind = poissonBinomial(ps);
  const mc = correlatedMC(legs.map(l => ({ P: l.P, league: l.league })), settings);

  const p8Ind = ind[n] ?? 0, p7Ind = ind[n - 1] ?? 0;
  const p8Mc = mc[n] ?? 0, p7Mc = mc[n - 1] ?? 0;

  const pPayInd = p8Ind + p7Ind;
  const pPayMc = p8Mc + p7Mc;
  const pPay = Math.min(pPayInd, pPayMc);

  const safeCount = ps.filter(p => p >= settings.safe).length;
  const weakest = legs.reduce((a, b) => (a.P < b.P ? a : b), legs[0]);

  const gateOk = safeCount >= 8 && pPay >= 0.15;

  return {
    n,
    mean_leg_P: round(ps.reduce((a, b) => a + b, 0) / n, 4),
    E_hits: round(ps.reduce((a, b) => a + b, 0), 2),
    P_8of8_independent: round(p8Ind, 4),
    P_8of8_correlated: round(p8Mc, 4),
    P_pay_7plus_independent: round(pPayInd, 4),
    P_pay_7plus_correlated: round(pPayMc, 4),
    P_pay_CONSERVATIVE: round(pPay, 4),
    legs_at_65pct: safeCount,
    weakest_leg: weakest ? `${weakest.name} (${(weakest.P * 100).toFixed(1)}%)` : null,
    gate_pass: gateOk,
    gate_message: gateOk
      ? 'PASS — play'
      : 'FAIL — skip (need >=8 legs @65% AND P(>=7/8)>=15%)',
    distribution_independent: ind,
    distribution_correlated: mc,
  };
}

/**
 * Poisson-binomial "count of GREEN legs" report for a Classic Pools fiche.
 * legs = [{name, P}] where P = P(1-1)+P(2-2) per leg.
 */
function poolsSlipReport(legs) {
  const ps = legs.map(l => l.P);
  const n = ps.length;
  const dist = poissonBinomial(ps);
  const pAtLeast = (k) => dist.slice(k).reduce((a, b) => a + b, 0);
  return {
    n,
    E_score_draws: round(ps.reduce((a, b) => a + b, 0), 2),
    P_2plus: round(pAtLeast(2), 4),
    P_3plus: round(pAtLeast(3), 4),
    P_4plus: round(pAtLeast(4), 4),
    distribution: dist,
  };
}

// ----------------------------------------------------------------------
// COUPON-LEVEL REWARD READ (parimutuel scarcity, BTTS Goal Rush only)
// ----------------------------------------------------------------------
function rewardRead(all35Probs, settings) {
  const safe = all35Probs.filter(p => p >= settings.safe).length;
  if (all35Probs.length < 30) {
    return {
      safe, verdict: 'INCOMPLETE',
      message: `${safe} safe legs — enter the full ~35-match board before reading reward.`,
    };
  }
  if (safe >= 12) {
    return {
      safe, verdict: 'DILUTED',
      message: `${safe} safe legs — DILUTED. Everyone finds an easy 8. Expect a low payout (~Rs 120). Single line only; multi-line staking here burns rupees.`,
    };
  }
  if (safe <= 8) {
    return {
      safe, verdict: 'SCARCE',
      message: `${safe} safe legs — SCARCE. This is the coupon worth attacking. Multi-line staking with varied 8-leg combinations is justified.`,
    };
  }
  return {
    safe, verdict: 'MIDDLING',
    message: `${safe} safe legs — middling. One line, maybe two if the tail is genuinely varied.`,
  };
}

function round(v, dp) {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

// ----------------------------------------------------------------------
// EXPORTS
// ----------------------------------------------------------------------
export {
  pois, dcMatrix, shrink, clamp, computeModel,
  evaluateBTTS, evaluateClassicPools,
  poissonBinomial, correlatedMC, slipReport, poolsSlipReport,
  rewardRead, round,
};
