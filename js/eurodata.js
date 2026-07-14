// ============================================================================
// eurodata.js — loader for the football-data.co.uk / openfootball derived team
// datasets. Four files are merged into one in-memory dataset:
//   euro_2025-26.json  — 22 major European leagues/divisions (football-data.co.uk)
//   world_2025-26.json — MLS, Japan J1, China, Colombia, Argentina, Paraguay,
//                        Ecuador, Brazil Serie A/B (openfootball match-by-match
//                        results, aggregated here to the same venue-split schema)
//   world2_2025-26.json — Austria (1st + 2nd tier), Kazakhstan, Mexico, Algeria,
//                        Egypt, Morocco, Nigeria, South Africa, Australia
//                        (openfootball football.json + world, same schema)
//   international_2025-26.json — UEFA Champions League 2025/26 (CL1, venue-split),
//                        Copa América 2024 / Gold Cup 2013 / AFCON 2025 / World
//                        Cup 2022 & 2026 (COPA24/GOLD13/AFCON25/WC22/WC26 — all
//                        neutral-venue tournaments, so h_* and a_* are set equal
//                        per team: no real home advantage to encode), plus two
//                        domestic gap-fills from openfootball/world (ISR1 Israel,
//                        CRC1 Costa Rica, venue-split as usual). GOLD13 is built
//                        from 2013 data (the repo has no 2015-2025 editions) —
//                        its low BTTS rate pushes it into the low_avoid tier
//                        automatically via mergeEuroLeaguesInto, and its display
//                        name says "(stale...)" so it's visible wherever it's
//                        listed. AFCON25/WC26 are group-stage-only (knockout
//                        rounds weren't available/resolved in the source repos
//                        as of build time) — also flagged in their names.
// League codes are disjoint across all four files (2-letter+digit European
// codes vs. 3-letter+digit world codes vs. named international codes) so
// merging is a plain object spread — no collisions, no risk of one file's
// league silently overwriting another's.
//
// A fifth file (euro_2024-26.json, two seasons pooled) ships alongside for
// reference/future use but is not wired into the UI yet.
// ============================================================================

const DATA_URLS = ['./data/euro_2025-26.json', './data/world_2025-26.json', './data/world2_2025-26.json', './data/international_2025-26.json'];

let _cache = null; // resolved, merged dataset, once fetched
let _loadingPromise = null;

async function fetchOne(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return r.json();
}

async function loadEuroData() {
  if (_cache) return _cache;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = Promise.allSettled(DATA_URLS.map(fetchOne)).then(results => {
    const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (ok.length === 0) {
      _loadingPromise = null;
      throw new Error(results.map(r => r.reason && r.reason.message).join('; '));
    }
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.warn(`EuroData: ${DATA_URLS[i]} failed to load — continuing with the rest.`, r.reason);
    });
    const merged = {
      source: ok.map(d => d.source).filter(Boolean).join(' + '),
      built: ok.map(d => d.built).filter(Boolean).sort().pop(),
      leagues: Object.assign({}, ...ok.map(d => d.leagues)),
      teams: Object.assign({}, ...ok.map(d => d.teams)),
    };
    _cache = merged;
    return merged;
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

// Generic club-type/descriptor words shared by many unrelated clubs across many
// countries (Rangers, United, City, Atletico, Deportivo, ...) -- matching on these
// alone produces false positives (e.g. "Brora Rangers" ~ "Rangers"; "Atletico GO"
// ~ any of six unrelated "Atlético ..." clubs across Argentina/Colombia/Paraguay).
const GENERIC_CLUB_WORDS = new Set([
  'rangers', 'united', 'city', 'athletic', 'albion', 'rovers', 'thistle', 'wanderers',
  'town', 'county', 'academical', 'academy',
  'atletico', 'deportivo', 'club', 'nacional', 'independiente', 'real', 'sporting',
  'racing', 'sport', 'union', 'national',
  // Added when merging Austria/Kazakhstan/Mexico/Algeria/Egypt/Morocco/Nigeria/
  // South Africa/Australia: place-name-as-club-prefix and descriptor words that
  // recur across multiple unrelated clubs within those countries (e.g. "Rapid Wien"
  // vs "Austria Wien"; "Rosario Central" vs "Central Coast Mariners").
  'austria', 'wien', 'stars', 'central',
  // Found via a real mismatch: "Universidad Central" (Venezuela, not in the
  // dataset) was silently matched to "Universidad Catolica" (Ecuador, an
  // unrelated club) on the shared token "universidad" alone -- this prefix
  // recurs across many unrelated Latin American university clubs (Chile,
  // Ecuador, Peru, Colombia, Venezuela, Bolivia), same failure mode as
  // "Atletico"/"Deportivo"/"Real"/"Sporting" above.
  'universidad',
]);

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
  // Generic words are excluded from counting as a match signal on their own -- e.g.
  // "atletico" alone must NOT tie together six unrelated "Atlético ..." clubs.
  const ta = aNorm.split(' ').filter(Boolean), tb = bNorm.split(' ').filter(Boolean);
  const setB = new Set(tb);
  const sharedAll = ta.filter(t => setB.has(t));
  const sharedMeaningful = sharedAll.filter(t => t.length >= 4 && !GENERIC_CLUB_WORDS.has(t));
  if (sharedMeaningful.length >= 2) return 85;
  if (sharedMeaningful.length === 1 && sharedMeaningful[0].length >= 5) return 65;
  // contracted/abbreviated first-token fallback (e.g. "Airdrieonians" -> "Airdrie Utd") --
  // skipped entirely when the first token is a generic word, for the same reason.
  const fa = ta[0] || '', fb = tb[0] || '';
  if (!GENERIC_CLUB_WORDS.has(fa) && !GENERIC_CLUB_WORDS.has(fb)) {
    const fShort = fa.length <= fb.length ? fa : fb;
    const fLong = fa.length <= fb.length ? fb : fa;
    if (fShort.length >= 5 && fLong.startsWith(fShort)) return 55;
  }
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
 * independently across every league in the dataset (home and away need not share a
 * league -- pre-season friendlies routinely cross divisions/countries).
 *
 * Returns { resolved, ambiguous, unresolved }:
 *   resolved   -- fixture objects ready to add to the board
 *   ambiguous  -- rows where a team name matched 2+ candidates equally well
 *   unresolved -- rows where a team wasn't found at all (commonly: a league
 *                outside the dataset)
 */
function resolveFixtureList(data, rows) {
  const resolved = [], ambiguous = [], unresolved = [];
  for (const row of rows) {
    const h = findTeamAcrossLeagues(data, row.home);
    const a = findTeamAcrossLeagues(data, row.away);
    if (!h || !a) {
      const reason = !h && !a ? 'neither team found in the dataset'
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
