// ============================================================================
// data.js — default league parameters, engine settings, reference tables
// Source: 02_ENGINE_v3.py, 04_LEAGUE_BASE_RATES.md, 05_PAYOUT_ECONOMICS.md,
//         06_CLASSIC_POOLS.md, 08_BTTS_DataStore_MASTER.json
// Consolidated 13 July 2026. League BTTS rates swing +/-40pts week to week —
// re-verify before trusting blindly. These are priors, not facts.
// ============================================================================

const DEFAULT_LEAGUES = {
  "Estonian Meistriliiga":  { base: 0.83, hg: 1.85, ag: 1.45, delta: 0.00,  tier: "high_core", note: "Highest observed BTTS core." },
  "Lithuania A Lyga":       { base: 0.80, hg: 1.70, ag: 1.35, delta: 0.00,  tier: "high_core", note: "" },
  "Iceland Besta deild":    { base: 0.79, hg: 1.70, ag: 1.30, delta: 0.05,  tier: "high_core", note: "Engine best-calibrated here." },
  "Norwegian OBOS-ligaen":  { base: 0.69, hg: 1.60, ag: 1.25, delta: -0.15, tier: "high_core", note: "Both early losing coupons died here. Home favourites stronger at home than season avgs suggest." },
  "Latvian Virsliga":       { base: 0.69, hg: 1.55, ag: 1.20, delta: 0.00,  tier: "high_core", note: "" },
  "Finnish Veikkausliiga":  { base: 0.67, hg: 1.45, ag: 1.10, delta: null,  tier: "high_core", note: "SYSTEMATIC AVOID despite headline rate — tight defences league-wide. Fixtures compute 39-48% in practice." },
  "Chilean Primera":        { base: 0.62, hg: 1.45, ag: 1.05, delta: 0.00,  tier: "mid", note: "" },
  "Allsvenskan":            { base: 0.60, hg: 1.55, ag: 1.20, delta: 0.00,  tier: "mid", note: "" },
  "MLS":                    { base: 0.59, hg: 1.60, ag: 1.25, delta: 0.00,  tier: "mid", note: "" },
  "Swedish Superettan":     { base: 0.57, hg: 1.50, ag: 1.15, delta: 0.00,  tier: "mid", note: "" },
  "USL Championship":       { base: 0.50, hg: 1.40, ag: 1.05, delta: 0.00,  tier: "low_avoid", note: "Coin-flip." },
  "Ecuador Serie A":        { base: 0.40, hg: 1.35, ag: 0.90, delta: 0.00,  tier: "low_avoid", note: "" },
  "League of Ireland":      { base: 0.40, hg: 1.35, ag: 0.95, delta: 0.00,  tier: "low_avoid", note: "" },
  "Brazil Serie B":         { base: 0.38, hg: 1.30, ag: 0.85, delta: -0.08, tier: "low_avoid", note: "" },
};

const DEFAULT_LEAGUE_FALLBACK = { base: 0.55, hg: 1.50, ag: 1.15, delta: 0.00, tier: "unknown", note: "Unrecognised league — using generic mid-table priors." };

const STRUCTURALLY_UNPLAYABLE = [
  "Australian NPL (state leagues)",
  "Iceland 1. Division / Is2",
  "Finnish Ykkonen",
  "Cross-tier cup ties (Scottish League Cup groups etc.)",
];

const DEFAULT_SETTINGS = {
  rho: -0.05,          // Dixon-Coles low-score correction
  k: 4.0,               // Bayesian shrinkage strength
  w: 0.25,               // humility blend weight toward league base (BTTS)
  safe: 0.65,             // "safe leg" threshold (BTTS)
  gammaSd: 0.12,           // per-league goal-environment sd, correlated MC
  mcIter: 12000,            // Monte Carlo iterations
  maxLegsPerLeague: 3,       // correlation control on an 8-leg slip

  // Classic Pools thresholds (06_CLASSIC_POOLS.md)
  poolsGapThreshold: 0.58,   // GAP filter: favourite win prob ceiling
  poolsXgLow: 2.0,           // XG filter window (combined lambda)
  poolsXgHigh: 2.6,
  poolsZeroZeroRisk: 0.12,   // 00 filter: P(0-0) ceiling
  poolsSafeThreshold: 0.16,  // "safe" GREEN leg — roughly base-rate-beating
};

// Discipline gate (BTTS Goal Rush) — 01_METHODOLOGY_MASTER.md §4
const DISCIPLINE_GATE = {
  condition1: ">= 8 legs at >= 65% calibrated P(BTTS)",
  condition2: "P(>=7/8) >= 15%, using the MORE CONSERVATIVE of independent Poisson-binomial and correlated Monte Carlo",
  benchmark: "Coupon-wide BTTS base rate stabilises at ~59%. 65% is the edge threshold.",
  note: "SKIP is a valid and frequently correct output.",
};

// Payout economics reference — 05_PAYOUT_ECONOMICS.md
const PAYOUT_REFERENCE = {
  empirical: [
    { tail: "Chilean / Iceland", tier: "8/8", payoutRs: 1101.74 },
    { tail: "Finnish / OBOS / Latvian", tier: "7/8", payoutRs: 424.42 },
    { tail: "USL (ticket 277838)", tier: "7/8", payoutRs: 123.02 },
  ],
  dilutionCurve: [
    { safeLegsOn35: "≥ 12", read: "DILUTED — everyone builds an easy 8. Tiny reward (~Rs 120).", staking: "Single line only." },
    { safeLegsOn35: "9–11", read: "Middling supply.", staking: "One line, maybe two if the tail is genuinely varied." },
    { safeLegsOn35: "≤ 8", read: "SCARCE — whole board low-BTTS, forces coin-flips. High reward.", staking: "Multi-line with varied 8-leg combinations." },
  ],
  historicDividendRanges: {
    goalRush8of8: "Rs 600 – 34,164",
    goalRush7of8: "Rs 120 – 600",
    classicPools24pts: "Rs 128,000 – 536,645",
    premier10: "up to Rs 1,857,390",
  },
};

// Classic Pools reference — 06_CLASSIC_POOLS.md
const CLASSIC_POOLS_REFERENCE = {
  scoring: [
    { colour: "GREEN", outcome: "Score draw (1-1, 2-2, …)", points: 3 },
    { colour: "BLUE", outcome: "0-0", points: 2 },
    { colour: "RED", outcome: "Decisive result", points: 1 },
    { colour: "VOID", outcome: "Postponed / abandoned", points: 2 },
  ],
  targetMetric: "score = P(1-1) + P(2-2) — NOT total draw probability",
  baseRate: "~9 score draws per 49 matches (~18%). Australian NPL ~15% — unplayable.",
  typicalSlipExpectation: { E_score_draws: 1.6, P_3plus: 0.20, P_4plus: 0.06 },
};

const REQUIRED_FIELDS_NOTE = "Minimum viable per fixture: hgf, hga (home GF/GA at home), agf, aga (away GF/GA away — agf is CRITICAL), n (matches played), league, runaway flag. Optional: fts_away, cs_home (enables zero-blend correction). If league_avg from your source is > 2.0, it's TOTAL goals/game — divide by 2.";

// Gemini/manual data-collection template — 07_DATA_PIPELINE.md
const FIXTURE_TEMPLATE = {
  matches: [
    {
      match_no: 1,
      fixture: "Home Team v Away Team",
      league: "League name",
      n: null,
      hgf: null, hga: null,
      agf: null, aga: null,
      fts_away: null, cs_home: null,
      runaway: 0,
      source: "URL",
    },
  ],
};

// Results-grading template — 07_DATA_PIPELINE.md
const RESULTS_TEMPLATE = {
  results: [
    { match_no: 1, fixture: "Home v Away", score: "2-1", btts: "YES", status: "FT" },
  ],
};

export {
  DEFAULT_LEAGUES, DEFAULT_LEAGUE_FALLBACK, STRUCTURALLY_UNPLAYABLE,
  DEFAULT_SETTINGS, DISCIPLINE_GATE, PAYOUT_REFERENCE, CLASSIC_POOLS_REFERENCE,
  REQUIRED_FIELDS_NOTE, FIXTURE_TEMPLATE, RESULTS_TEMPLATE,
};
