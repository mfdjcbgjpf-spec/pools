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
      note: `EuroData ${code} n=${meta.n} matches score-draw ${meta.score_draw}% 0-0 ${meta.nil_nil}%`,
    };
    added++;
  }
  return added;
}

// ----------------------------------------------------------------------
// NAME MATCHING -- resolve raw "Home Team" / "Away Team" strings (e.g.
// copy-pasted straight from Lottotech's fixture list) against the dataset,
// without the user needing to pick a league or exact spelling first.
// ----------------------------------------------------------------------

/** Lowercase, strip diacritics/punctuation/common suffixes for fuzzy compare. */
function normalizeTeamName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[.'`]/g, '')
    .replace(/\b(fc|afc|cf|sc)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Generic club-type words shared by many unrelated clubs (Rangers, United, City, ...) --
// matching on these alone produces false positives (e.g. "Brora Rangers" ~ "Rangers").
const GENERIC_CLUB_WORDS = new Set(['rangers', 'united', 'city', 'athletic', 'albion', 'rovers', 'thistle', 'wanderers', 'town', 'county', 'academical', 'academy']);

/**
 * Score how well two already-normalized names match.
 * 100 = exact.
 * 90  = one is a whole-word prefix (or non-generic whole-word suffix) of the other
 *       (handles "Partick Thistle" -> "Partick", "Greenock Morton" -> "Morton").
 * 85  = 2+ exact tokens shared (handles "Queen of the South" -> "Queen of Sth").
 * 65  = exactly 1 shared token, >=5 chars, not a generic club word.
 * 55  = first tokens share a contraction/abbreviation prefix relationship
 *       (handles "Airdrieonians" -> "Airdrie Utd").
 * 0   = no match.
 */
function teamMatchScore(aNorm, bNorm) {
  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return 100;
  const shorter = aNorm.length <= bNorm.length ? aNorm : bNorm;
  const longer = aNorm.length <= bNorm.length ? bNorm : aNorm;
  // whole-word prefix (e.g. "Partick Thistle" -> "Partick"; "Ayr United" -> "Ayr") -- the
  // leading word in lower-league names is almost always a unique place name, safe to trust.
  if (longer.startsWith(shorter + ' ')) return 90;
  // whole-word suffix (e.g. "Greenock Morton" -> "Morton") -- but NOT for generic club-type
  // words that recur across many unrelated clubs (Rangers, United, City, ...), since those
  // produce dangerous false positives (e.g. "Brora Rangers" must NOT match "Rangers").
  if (longer.endsWith(' ' + shorter) && !GENERIC_CLUB_WORDS.has(shorter)) return 90;
  // exact-token overlap (e.g. "Queen of the South" -> "Queen of Sth"; "Raith Rovers" -> "Raith Rvs")
  const ta = aNorm.split(' ').filter(Boolean), tb = bNorm.split(' ').filter(Boolean);
  const setB = new Set(tb);
  const shared = ta.filter(t => setB.has(t));
  if (shared.length >= 2) return 85;
  // a single shared token only counts if it's not a generic club-type word shared by many
  // unrelated clubs (Rangers, United, City, ...) -- that produces false positives like
  // "Brora Rangers" partially matching "Rangers" or "Cove Rangers".
  if (shared.length === 1 && shared[0].length >= 5 && !GENERIC_CLUB_WORDS.has(shared[0])) return 65;
  // contracted/abbreviated first-token fallback (e.g. "Airdrieonians" -> "Airdrie Utd")
  const fa = ta[0] || '', fb = tb[0] || '';
  const fShort = fa.length <= fb.length ? fa : fb;
  const fLong = fa.length <= fb.length ? fb : fa;
  if (fShort.length >= 5 && fLong.startsWith(fShort)) return 55;
  return 0;
}

/**
 * Search every league/team in the dataset for the best match to a raw team
 * name. Returns { code, name, score, ambiguous } or null if nothing scores
 * above 0. `ambiguous: true` means two+ different teams tied for top score
 * -- caller should not auto-add these without confirmation.
 */
function findTeamAcrossLeagues(data, rawName) {
  const target = normalizeTeamName(rawName);
  if (!target) return null;
  let best = null;
  for (const [code, teams] of Object.entries(data.teams)) {
    for (const teamName of Object.keys(teams)) {
      const score = teamMatchScore(target, normalizeTeamName(teamName));
      if (score === 0) continue;
      if (!best || score > best.score) {
        best = { code, name: teamName, score, ambiguous: false };
      } else if (score === best.score && (code !== best.code || teamName !== best.name)) {
        best.ambiguous = true;
      }
    }
  }
  return best;
}

/**
 * Build a fixture from two resolved team matches (possibly in different
 * leagues -- e.g. pre-season friendlies crossing divisions/countries).
 */
function buildFixtureFromMatches(data, homeMatch, awayMatch, matchNo) {
  const homeLg = getLeagueMeta(data, homeMatch.code);
  const awayLg = getLeagueMeta(data, awayMatch.code);
  const home = getTeamStats(data, homeMatch.code, homeMatch.name);
  const away = getTeamStats(data, awayMatch.code, awayMatch.name);
  if (!homeLg || !awayLg || !home || !away) return null;

  const n = Math.max(1, Math.round((home.h_p + away.a_p) / 2));
  const fixture = `${homeMatch.name} v ${awayMatch.name}`;
  const league = homeMatch.code === awayMatch.code ? homeLg.name : `${homeLg.name} / ${awayLg.name}`;
  const id = `tp_${homeMatch.code}_${homeMatch.name}_${awayMatch.code}_${awayMatch.name}`;

  return {
    id,
    match_no: matchNo ?? null,
    fixture, home: homeMatch.name, away: awayMatch.name,
    league, n,
    hgf: home.h_gf, hga: home.h_ga,
    agf: away.a_gf, aga: away.a_ga,
    fts_away: away.a_sr != null ? round((100 - away.a_sr) / 100, 3) : null,
    cs_home: home.h_cs != null ? round(home.h_cs / 100, 3) : null,
    runaway: 0,
    source: 'football-data.co.uk (2025-26 season) via auto-match paste',
  };
}

/**
 * Resolve a raw fixture list -- [{match_no, home, away}] straight off a
 * pasted Lottotech coupon -- against the dataset. Every team is searched
 * independently across ALL 22 leagues (home and away need not share a
 * league -- pre-season friendlies routinely cross divisions/countries).
 *
 * Returns { resolved, ambiguous, unresolved }:
 *   resolved   -- fixture objects ready to add to the board
 *   ambiguous  -- rows where a team name matched 2+ candidates equally well
 *   unresolved -- rows where a team wasn't found at all (commonly: a league
 *                outside the 22 covered here, e.g. Norway/Sweden/Brazil)
 */
function resolveFixtureList(data, rows) {
  const resolved = [], ambiguous = [], unresolved = [];
  for (const row of rows) {
    const h = findTeamAcrossLeagues(data, row.home);
    const a = findTeamAcrossLeagues(data, row.away);
    if (!h || !a) {
      const reason = !h && !a ? 'neither team found in the 22-league dataset'
        : !h ? `"${row.home}" not found` : `"${row.away}" not found`;
      unresolved.push({ ...row, reason });
      continue;
    }
    if (h.ambiguous || a.ambiguous) {
      ambiguous.push({ ...row, homeMatch: h, awayMatch: a });
      continue;
    }
    const fixture = buildFixtureFromMatches(data, h, a, row.match_no);
    if (!fixture) { unresolved.push({ ...row, reason: 'stats missing for matched team' }); continue; }
    resolved.push(fixture);
  }
  return { resolved, ambiguous, unresolved };
}

export {
  loadEuroData, getLeagueList, getTeamList, getLeagueMeta, getTeamStats,
  buildFixtureFromTeams, mergeEuroLeaguesInto,
  normalizeTeamName, teamMatchScore, findTeamAcrossLeagues,
  buildFixtureFromMatches, resolveFixtureList,
};
