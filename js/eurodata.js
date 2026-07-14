// ============================================================================
// eurodata.js — loader for the football-data.co.uk derived European dataset
// Source: EuroData_2025-26_BTTS_Pools_DataStore.json (single completed season,
// freshest signal) — 22 major European leagues/divisions, team-level venue
// splits (home/away goals for/against, clean sheets, scoring rate).
//
// A second file (euro_2024-26.json, two seasons pooled) ships alongside for
// reference/future use but is not wired into the UI yet — 2025-26 alone is
// more current and every league in it has a full, complete season already.
// ============================================================================

const DATA_URL = './data/euro_2025-26.json';

let _cache = null; // resolved dataset, once fetched
let _loadingPromise = null;

async function loadEuroData() {
  if (_cache) return _cache;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = fetch(DATA_URL)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${DATA_URL}`);
      return r.json();
    })
    .then(data => { _cache = data; return data; })
    .catch(err => {
      _loadingPromise = null; // allow retry on next call
      throw err;
    });
  return _loadingPromise;
}

/** [{code, name}] sorted by name, for populating a <select>. */
function getLeagueList(data) {
  return Object.entries(data.leagues)
    .map(([code, meta]) => ({ code, name: meta.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Team names for a league code, sorted alphabetically. */
function getTeamList(data, code) {
  const teams = data.teams[code];
  if (!teams) return [];
  return Object.keys(teams).sort((a, b) => a.localeCompare(b));
}

function getLeagueMeta(data, code) {
  return data.leagues[code] || null;
}

function getTeamStats(data, code, teamName) {
  const teams = data.teams[code];
  return teams ? (teams[teamName] || null) : null;
}

function round(v, dp) {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

/**
 * Build a normalized fixture object (same shape app.js's normalizeMatch()
 * produces) from two team-stat records looked up by league code.
 * Returns null if either team is missing from the dataset.
 */
function buildFixtureFromTeams(data, code, homeTeamName, awayTeamName, matchNo) {
  const league = getLeagueMeta(data, code);
  const home = getTeamStats(data, code, homeTeamName);
  const away = getTeamStats(data, code, awayTeamName);
  if (!league || !home || !away) return null;

  const n = Math.max(1, Math.round((home.h_p + away.a_p) / 2));
  const fixture = `${homeTeamName} v ${awayTeamName}`;
  const id = `tp_${code}_${homeTeamName}_${awayTeamName}`;

  return {
    id,
    match_no: matchNo ?? null,
    fixture, home: homeTeamName, away: awayTeamName,
    league: league.name,
    n,
    hgf: home.h_gf, hga: home.h_ga,
    agf: away.a_gf, aga: away.a_ga,
    fts_away: away.a_sr != null ? round((100 - away.a_sr) / 100, 3) : null,
    cs_home: home.h_cs != null ? round(home.h_cs / 100, 3) : null,
    runaway: 0,
    source: 'football-data.co.uk (2025-26 season) via EuroData picker',
  };
}

/**
 * Additive-only merge of euro league priors into a leagues table (e.g.
 * state.leagues). Never overwrites an existing key — so user edits and the
 * original niche-league table are always preserved.
 */
function mergeEuroLeaguesInto(leaguesTable, data) {
  let added = 0;
  for (const [code, meta] of Object.entries(data.leagues)) {
    if (leaguesTable[meta.name]) continue; // don't clobber existing/edited entries
    const base = meta.btts / 100;
    let tier = 'mid';
    if (base >= 0.65) tier = 'high_core';
    else if (base < 0.52) tier = 'low_avoid';
    leaguesTable[meta.name] = {
      base: round(base, 3),
      hg: meta.home_gf,
      ag: meta.away_gf,
      delta: 0.00,
      tier,
      note: `EuroData ${code} · n=${meta.n} matches · score-draw ${meta.score_draw}% · 0-0 ${meta.nil_nil}%`,
    };
    added++;
  }
  return added;
}

export {
  loadEuroData, getLeagueList, getTeamList, getLeagueMeta, getTeamStats,
  buildFixtureFromTeams, mergeEuroLeaguesInto,
};
