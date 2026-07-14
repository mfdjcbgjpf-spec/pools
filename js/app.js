// ============================================================================
// app.js — UI wiring for the BTTS / Classic Pools predictor
// No framework, no build step — plain DOM so this runs unmodified on
// GitHub Pages. Everything is derived fresh from `state` on every render.
// ============================================================================

import * as E from './engine.js';
import * as Euro from './eurodata.js';
import {
  DEFAULT_LEAGUES, DEFAULT_LEAGUE_FALLBACK, STRUCTURALLY_UNPLAYABLE,
  DEFAULT_SETTINGS, PAYOUT_REFERENCE, CLASSIC_POOLS_REFERENCE,
  REQUIRED_FIELDS_NOTE, FIXTURE_TEMPLATE, RESULTS_TEMPLATE, PAST_TICKET_TEMPLATE,
} from './data.js';
import {
  loadState, saveState, resetState, makeTicket, exportState, importStateFromText,
} from './storage.js';

let state = loadState();
const picks = { btts: new Set(), pools: new Set() };
let computedCache = { btts: [], pools: [] };
let euroDataCache = null;

function save() { saveState(state); }

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = isError ? 'var(--red)' : 'var(--card-border)';
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getLeague(name) {
  return state.leagues[name] || DEFAULT_LEAGUE_FALLBACK;
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ----------------------------------------------------------------------
// TABS
// ----------------------------------------------------------------------
document.getElementById('tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
});

// ----------------------------------------------------------------------
// FIXTURE PARSING
// ----------------------------------------------------------------------
function splitFixture(fixture) {
  const parts = String(fixture).split(/\s+v\.?\s+|\s+vs\.?\s+/i);
  if (parts.length === 2) return { home: parts[0].trim(), away: parts[1].trim() };
  return { home: fixture, away: '' };
}

function normalizeMatch(raw, idx) {
  let home = raw.home_team || (typeof raw.home === 'string' ? raw.home : null);
  let away = raw.away_team || (typeof raw.away === 'string' ? raw.away : null);
  if ((!home || !away) && raw.fixture) {
    const s = splitFixture(raw.fixture);
    home = home || s.home; away = away || s.away;
  }
  const fixture = raw.fixture || `${home} v ${away}`;
  const id = raw.match_no != null ? `m${raw.match_no}` : `f_${fixture}_${idx}`;
  const homeObj = (raw.home && typeof raw.home === 'object') ? raw.home : {};
  const awayObj = (raw.away && typeof raw.away === 'object') ? raw.away : {};
  let leagueAvg = numOrNull(raw.league_avg);
  if (leagueAvg !== null && leagueAvg > 2.0) leagueAvg = leagueAvg / 2;

  return {
    id,
    match_no: raw.match_no ?? null,
    fixture, home: home || '?', away: away || '?',
    league: raw.league || 'Unknown',
    n: numOrNull(raw.n ?? homeObj.mp ?? awayObj.mp) ?? 10,
    hgf: numOrNull(raw.hgf ?? homeObj.home_gf ?? homeObj.gf),
    hga: numOrNull(raw.hga ?? homeObj.home_ga ?? homeObj.ga),
    agf: numOrNull(raw.agf ?? awayObj.away_gf ?? awayObj.gf),
    aga: numOrNull(raw.aga ?? awayObj.away_ga ?? awayObj.ga),
    fts_away: numOrNull(raw.fts_away ?? awayObj.fts_rate),
    cs_home: numOrNull(raw.cs_home ?? homeObj.cs_rate),
    runaway: raw.runaway ? 1 : 0,
    source: raw.source || '',
  };
}

function parseFixturesJSON(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : (data.matches || []);
  if (!Array.isArray(list) || list.length === 0) throw new Error('No "matches" array found in the pasted JSON.');
  return list.map((raw, idx) => normalizeMatch(raw, idx));
}

function parseFixtureTable(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    if (/^\|?\s*:?-+:?\s*\|/.test(line)) continue; // markdown separator row
    let cells;
    if (line.includes('|')) {
      cells = line.split('|').map(c => c.trim());
      if (cells[0] === '') cells.shift();
      if (cells.length && cells[cells.length - 1] === '') cells.pop();
    } else if (line.includes('\t')) {
      cells = line.split('\t').map(c => c.trim());
    } else {
      cells = line.split(',').map(c => c.trim());
    }
    if (cells.length < 3) continue;
    const [noRaw, home, away] = cells;
    if (/match|no\.?$/i.test(noRaw) && /home/i.test(home || '')) continue; // header row
    if (!home || !away) continue;
    const match_no = parseInt(noRaw, 10);
    rows.push({ match_no: Number.isFinite(match_no) ? match_no : null, home, away });
  }
  return rows;
}

function isComplete(m) {
  return [m.hgf, m.hga, m.agf, m.aga].every(v => v !== null && v !== undefined);
}

function upsertBoard(board, matches) {
  for (const m of matches) {
    const i = board.findIndex(x => x.id === m.id);
    if (i >= 0) board[i] = m; else board.push(m);
  }
}

// ----------------------------------------------------------------------
// COMPUTE + RENDER — BTTS
// ----------------------------------------------------------------------
function computeBtts() {
  const settings = state.settings;
  return state.bttsBoard.map(m => {
    if (!isComplete(m)) return { ...m, incomplete: true };
    const league = getLeague(m.league);
    const r = E.evaluateBTTS(m, league, settings);
    return { ...m, ...r, incomplete: false };
  });
}

function rowClass(r) {
  if (r.incomplete) return '';
  if (r.drop) return 'row-drop';
  if (r.safe) return 'row-safe';
  if (r.flags && r.flags.length) return 'row-caution';
  return '';
}

function flagChips(flags) {
  if (!flags || !flags.length) return '';
  return flags.map(f => `<span class="flag-chip">${esc(f[1] || f[0])}</span>`).join(' ');
}

function renderBttsTable(results) {
  const table = document.getElementById('btts-table');
  const valid = results.filter(r => !r.incomplete).sort((a, b) => b.P - a.P);
  const incomplete = results.filter(r => r.incomplete);

  table.querySelector('thead').innerHTML = `<tr>
    <th></th><th>#</th><th>Fixture</th><th>League</th><th>P(BTTS)</th>
    <th>λH</th><th>λA</th><th>Flags</th><th>Verdict</th></tr>`;

  const rows = valid.map(r => `
    <tr class="${rowClass(r)}">
      <td><label class="checkbox-cell"><input type="checkbox" class="btts-pick" data-id="${esc(r.id)}" ${picks.btts.has(r.id) ? 'checked' : ''}></label></td>
      <td>${r.match_no ?? ''}</td>
      <td>${esc(r.fixture)}</td>
      <td>${esc(r.league)}</td>
      <td><strong>${(r.P * 100).toFixed(1)}%</strong></td>
      <td>${r.lh}</td><td>${r.la}</td>
      <td>${flagChips(r.flags)}</td>
      <td>${r.drop ? '<span class="tag-drop">DROP</span>' : (r.safe ? '<span class="tag-safe">SAFE</span>' : '<span class="tag-caution">watch</span>')}</td>
    </tr>`).join('');

  const incRows = incomplete.map(r => `
    <tr><td></td><td>${r.match_no ?? ''}</td><td>${esc(r.fixture)}</td><td>${esc(r.league)}</td>
      <td colspan="5" class="hint">Missing hgf/hga/agf/aga — cannot evaluate.</td></tr>`).join('');

  table.querySelector('tbody').innerHTML = rows + incRows || `<tr><td colspan="9" class="hint">No fixtures on the board yet.</td></tr>`;

  table.querySelectorAll('.btts-pick').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) picks.btts.add(cb.dataset.id); else picks.btts.delete(cb.dataset.id);
      renderBttsSlip();
    });
  });

  // reward read across the whole board
  const rewardEl = document.getElementById('btts-reward-read');
  if (valid.length) {
    const read = E.rewardRead(valid.map(r => r.P), state.settings);
    rewardEl.className = `reward-box ${read.verdict.toLowerCase()}`;
    rewardEl.innerHTML = `<strong>Board scarcity:</strong> ${esc(read.message)}`;
  } else {
    rewardEl.className = 'reward-box';
    rewardEl.innerHTML = '';
  }

  renderLeagueTable('btts-league-table', valid, 'P');
}

function renderBttsSlip() {
  const results = computedCache.btts;
  const legs = results.filter(r => picks.btts.has(r.id)).map(r => ({ name: r.fixture, P: r.P, league: r.league }));
  const el = document.getElementById('btts-slip-report');
  if (legs.length === 0) { el.innerHTML = '<p class="hint">No legs picked yet.</p>'; return; }

  const report = E.slipReport(legs, state.settings);
  const leagueCounts = {};
  legs.forEach(l => { leagueCounts[l.league] = (leagueCounts[l.league] || 0) + 1; });
  const overCap = Object.entries(leagueCounts).filter(([, c]) => c > state.settings.maxLegsPerLeague);

  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><div class="label">Legs picked</div><div class="value">${report.n}</div></div>
      <div class="stat-box"><div class="label">E[hits]</div><div class="value">${report.E_hits}</div></div>
      <div class="stat-box"><div class="label">Legs ≥65%</div><div class="value">${report.legs_at_65pct}</div></div>
      <div class="stat-box"><div class="label">P(8/8) indep.</div><div class="value">${(report.P_8of8_independent * 100).toFixed(1)}%</div></div>
      <div class="stat-box"><div class="label">P(≥7/8) conservative</div><div class="value">${(report.P_pay_CONSERVATIVE * 100).toFixed(1)}%</div></div>
    </div>
    <p>Weakest leg: <strong>${esc(report.weakest_leg || '—')}</strong></p>
    <p class="${report.gate_pass ? 'gate-pass' : 'gate-fail'}">Discipline gate: ${esc(report.gate_message)}</p>
    ${overCap.length ? `<p class="tag-caution">⚠ Over the ${state.settings.maxLegsPerLeague}-per-league cap: ${overCap.map(([lg, c]) => `${esc(lg)} (${c})`).join(', ')}</p>` : ''}
  `;
}

function autopickBtts() {
  const valid = computedCache.btts.filter(r => !r.incomplete && !r.drop).sort((a, b) => b.P - a.P);
  picks.btts.clear();
  const perLeague = {};
  for (const r of valid) {
    if (picks.btts.size >= 8) break;
    const c = perLeague[r.league] || 0;
    if (c >= state.settings.maxLegsPerLeague) continue;
    picks.btts.add(r.id);
    perLeague[r.league] = c + 1;
  }
  renderAll('btts');
}

// ----------------------------------------------------------------------
// COMPUTE + RENDER — CLASSIC POOLS
// ----------------------------------------------------------------------
function computePools() {
  const settings = state.settings;
  return state.poolsBoard.map(m => {
    if (!isComplete(m)) return { ...m, incomplete: true };
    const league = getLeague(m.league);
    const r = E.evaluateClassicPools(m, league, settings);
    return { ...m, ...r, incomplete: false };
  });
}

function renderPoolsTable(results) {
  const table = document.getElementById('pools-table');
  const valid = results.filter(r => !r.incomplete).sort((a, b) => b.score - a.score);
  const incomplete = results.filter(r => r.incomplete);

  table.querySelector('thead').innerHTML = `<tr>
    <th></th><th>#</th><th>Fixture</th><th>League</th><th>P(1-1)+P(2-2)</th>
    <th>λH</th><th>λA</th><th>Fav. win</th><th>Flags</th><th>Verdict</th></tr>`;

  const rows = valid.map(r => `
    <tr class="${r.drop ? 'row-drop' : (r.safe ? 'row-safe' : (r.flags.length ? 'row-caution' : ''))}">
      <td><label class="checkbox-cell"><input type="checkbox" class="pools-pick" data-id="${esc(r.id)}" ${picks.pools.has(r.id) ? 'checked' : ''}></label></td>
      <td>${r.match_no ?? ''}</td>
      <td>${esc(r.fixture)}</td>
      <td>${esc(r.league)}</td>
      <td><strong>${(r.score * 100).toFixed(1)}%</strong></td>
      <td>${r.lh}</td><td>${r.la}</td>
      <td>${(r.favourite * 100).toFixed(0)}%</td>
      <td>${flagChips(r.flags)}</td>
      <td>${r.drop ? '<span class="tag-drop">DROP</span>' : (r.safe ? '<span class="tag-safe">SAFE</span>' : '<span class="tag-caution">watch</span>')}</td>
    </tr>`).join('');

  const incRows = incomplete.map(r => `
    <tr><td></td><td>${r.match_no ?? ''}</td><td>${esc(r.fixture)}</td><td>${esc(r.league)}</td>
      <td colspan="6" class="hint">Missing hgf/hga/agf/aga — cannot evaluate.</td></tr>`).join('');

  table.querySelector('tbody').innerHTML = rows + incRows || `<tr><td colspan="10" class="hint">No fixtures on the board yet.</td></tr>`;

  table.querySelectorAll('.pools-pick').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) picks.pools.add(cb.dataset.id); else picks.pools.delete(cb.dataset.id);
      renderPoolsSlip();
    });
  });

  renderLeagueTable('pools-league-table', valid, 'score');
}

function renderPoolsSlip() {
  const results = computedCache.pools;
  const legs = results.filter(r => picks.pools.has(r.id)).map(r => ({ name: r.fixture, P: r.score }));
  const el = document.getElementById('pools-slip-report');
  if (legs.length === 0) { el.innerHTML = '<p class="hint">No legs picked yet.</p>'; return; }
  const report = E.poolsSlipReport(legs);
  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><div class="label">Legs picked</div><div class="value">${report.n}</div></div>
      <div class="stat-box"><div class="label">E[score draws]</div><div class="value">${report.E_score_draws}</div></div>
      <div class="stat-box"><div class="label">P(≥2)</div><div class="value">${(report.P_2plus * 100).toFixed(1)}%</div></div>
      <div class="stat-box"><div class="label">P(≥3)</div><div class="value">${(report.P_3plus * 100).toFixed(1)}%</div></div>
      <div class="stat-box"><div class="label">P(≥4)</div><div class="value">${(report.P_4plus * 100).toFixed(1)}%</div></div>
    </div>
    <p class="hint">Reference fiche (11 legs, validated): E≈1.6, P(≥3)≈20%, P(≥4)≈6%.</p>
  `;
}

function autopickPools() {
  const valid = computedCache.pools.filter(r => !r.incomplete && !r.drop).sort((a, b) => b.score - a.score);
  picks.pools.clear();
  for (const r of valid) {
    if (picks.pools.size >= 11) break;
    picks.pools.add(r.id);
  }
  renderAll('pools');
}

// ----------------------------------------------------------------------
// LEAGUE RANKING TABLE (shared by both tabs)
// ----------------------------------------------------------------------
function renderLeagueTable(tableId, valid, metricKey) {
  const table = document.getElementById(tableId);
  const byLeague = {};
  for (const r of valid) {
    const lg = r.league;
    byLeague[lg] = byLeague[lg] || { n: 0, sum: 0, safe: 0 };
    byLeague[lg].n++;
    byLeague[lg].sum += r[metricKey];
    if (r.safe) byLeague[lg].safe++;
  }
  const rows = Object.entries(byLeague)
    .map(([lg, d]) => ({ lg, n: d.n, avg: d.sum / d.n, safe: d.safe }))
    .sort((a, b) => b.avg - a.avg);

  table.querySelector('thead').innerHTML = `<tr><th>League</th><th>Fixtures</th><th>Avg</th><th>Safe legs</th><th>Prior tier</th></tr>`;
  table.querySelector('tbody').innerHTML = rows.map(r => {
    const staticInfo = state.leagues[r.lg];
    const tier = staticInfo ? staticInfo.tier : 'unknown';
    const lgLower = r.lg.toLowerCase();
    const unplayable = STRUCTURALLY_UNPLAYABLE.some(u => {
      const uLower = u.toLowerCase();
      return uLower === lgLower || uLower.includes(lgLower) || lgLower.includes(uLower);
    });
    return `<tr>
      <td>${esc(r.lg)}</td>
      <td>${r.n}</td>
      <td><strong>${(r.avg * 100).toFixed(1)}%</strong></td>
      <td>${r.safe}</td>
      <td class="tier-${tier}">${unplayable ? '⛔ unplayable' : tier.replace('_', ' ')}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" class="hint">Nothing to rank yet.</td></tr>`;
}

// ----------------------------------------------------------------------
// RENDER ORCHESTRATION
// ----------------------------------------------------------------------
function renderAll(which) {
  if (!which || which === 'btts') {
    computedCache.btts = computeBtts();
    renderBttsTable(computedCache.btts);
    renderBttsSlip();
  }
  if (!which || which === 'pools') {
    computedCache.pools = computePools();
    renderPoolsTable(computedCache.pools);
    renderPoolsSlip();
  }
}

// ----------------------------------------------------------------------
// BOARD INPUT HANDLERS
// ----------------------------------------------------------------------
function wireBoardInput(prefix, boardKey, mode) {
  document.getElementById(`${prefix}-parse-btn`).addEventListener('click', () => {
    const text = document.getElementById(`${prefix}-input`).value.trim();
    const msg = document.getElementById(`${prefix}-parse-msg`);
    if (!text) { msg.textContent = 'Paste some JSON first.'; msg.classList.add('error'); return; }
    try {
      const matches = parseFixturesJSON(text);
      upsertBoard(state[boardKey], matches);
      save();
      msg.classList.remove('error');
      msg.textContent = `Added/updated ${matches.length} fixture(s). Board now has ${state[boardKey].length}.`;
      document.getElementById(`${prefix}-input`).value = '';
      renderAll(mode);
    } catch (e) {
      msg.classList.add('error');
      msg.textContent = `Could not parse: ${e.message}`;
    }
  });

  document.getElementById(`${prefix}-clear-btn`).addEventListener('click', () => {
    if (!confirm('Clear the entire board? This does not affect saved tickets.')) return;
    state[boardKey] = [];
    picks[mode].clear();
    save();
    renderAll(mode);
    toast('Board cleared.');
  });

  document.getElementById(`${prefix}-template-btn`).addEventListener('click', () => {
    downloadJSON(FIXTURE_TEMPLATE, `fixture-template-${mode}.json`);
  });
}

// ----------------------------------------------------------------------
// TEAM PICKER (EuroData quick-add)
// ----------------------------------------------------------------------
function wireTeamPicker(prefix, boardKey, mode) {
  const leagueSel = document.getElementById(`${prefix}-tp-league`);
  const homeSel = document.getElementById(`${prefix}-tp-home`);
  const awaySel = document.getElementById(`${prefix}-tp-away`);
  const addBtn = document.getElementById(`${prefix}-tp-add-btn`);
  if (!leagueSel || !addBtn) return;

  leagueSel.addEventListener('change', () => {
    const code = leagueSel.value;
    homeSel.innerHTML = '<option value="">Home team…</option>';
    awaySel.innerHTML = '<option value="">Away team…</option>';
    if (!code || !euroDataCache) return;
    const teams = Euro.getTeamList(euroDataCache, code);
    const opts = teams.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    homeSel.insertAdjacentHTML('beforeend', opts);
    awaySel.insertAdjacentHTML('beforeend', opts);
  });

  addBtn.addEventListener('click', () => {
    if (!euroDataCache) { toast('Team data still loading — try again in a moment.', true); return; }
    const code = leagueSel.value, home = homeSel.value, away = awaySel.value;
    if (!code || !home || !away) { toast('Pick a league, home team and away team first.', true); return; }
    if (home === away) { toast('Home and away team must be different.', true); return; }
    const board = state[boardKey];
    const matchNo = board.length ? Math.max(0, ...board.map(m => m.match_no || 0)) + 1 : 1;
    const fixture = Euro.buildFixtureFromTeams(euroDataCache, code, home, away, matchNo);
    if (!fixture) { toast('Could not build that fixture — missing team data.', true); return; }
    upsertBoard(board, [fixture]);
    save();
    renderAll(mode);
    toast(`Added ${fixture.fixture} (${fixture.league}).`);
  });
}

function wireQuickPasteNames(prefix, boardKey, mode) {
  const btn = document.getElementById(`${prefix}-names-btn`);
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!euroDataCache) { toast('Team data still loading — try again in a moment.', true); return; }
    const input = document.getElementById(`${prefix}-names-input`);
    const msg = document.getElementById(`${prefix}-names-msg`);
    const text = input.value.trim();
    if (!text) { msg.classList.add('error'); msg.textContent = 'Paste a fixture list first.'; return; }
    const rows = parseFixtureTable(text);
    if (rows.length === 0) {
      msg.classList.add('error');
      msg.textContent = 'Could not find any rows — expected "| No | Home | Away |" per line.';
      return;
    }
    const { resolved, ambiguous, unresolved } = Euro.resolveFixtureList(euroDataCache, rows);
    if (resolved.length) {
      upsertBoard(state[boardKey], resolved);
      save();
      renderAll(mode);
      input.value = '';
    }
    msg.classList.remove('error');
    const parts = [`Matched ${resolved.length}/${rows.length} fixture(s) and added to the board.`];
    if (ambiguous.length) {
      parts.push(`${ambiguous.length} ambiguous (name matched 2+ teams) — add via the picker above instead: ${ambiguous.map(r => `${r.home} v ${r.away}`).join(', ')}.`);
    }
    if (unresolved.length) {
      parts.push(`${unresolved.length} not in the 22-league dataset — use "Paste the board" below with their own stats: ${unresolved.map(r => `${r.home} v ${r.away}`).join(', ')}.`);
    }
    msg.textContent = parts.join(' ');
    if (resolved.length) toast(`Auto-matched ${resolved.length} fixture(s) from pasted names.`);
  });
}

async function initEuroData() {
  const prefixes = ['btts', 'pools'];
  try {
    const data = await Euro.loadEuroData();
    euroDataCache = data;
    const leagues = Euro.getLeagueList(data);
    const optionsHtml = '<option value="">League…</option>'
      + leagues.map(l => `<option value="${esc(l.code)}">${esc(l.name)}</option>`).join('');
    for (const prefix of prefixes) {
      const sel = document.getElementById(`${prefix}-tp-league`);
      const status = document.getElementById(`${prefix}-tp-status`);
      if (sel) sel.innerHTML = optionsHtml;
      if (status) { status.classList.remove('error'); status.textContent = `${leagues.length} leagues, ${Object.values(data.teams).reduce((a, t) => a + Object.keys(t).length, 0)} teams loaded (2025-26 season).`; }
    }
    const added = Euro.mergeEuroLeaguesInto(state.leagues, data);
    if (added > 0) {
      save();
      renderLeaguesTable();
      renderAll();
    }
  } catch (e) {
    console.error('EuroData load failed', e);
    for (const prefix of prefixes) {
      const status = document.getElementById(`${prefix}-tp-status`);
      if (status) { status.classList.add('error'); status.textContent = 'Could not load team data — the paste box below still works normally.'; }
    }
  }
}

// ----------------------------------------------------------------------
// TICKETS — save / list / grade
// ----------------------------------------------------------------------
function wireTicketSave(prefix, mode) {
  document.getElementById(`${prefix}-save-ticket-btn`).addEventListener('click', () => {
    const ids = [...picks[mode]];
    if (ids.length === 0) { toast('Pick at least one leg first.', true); return; }
    const results = computedCache[mode];
    const legs = results.filter(r => ids.includes(r.id)).map(r => ({
      id: r.id, match_no: r.match_no, fixture: r.fixture, league: r.league,
      P: mode === 'btts' ? r.P : r.score,
    }));
    const slipStats = mode === 'btts'
      ? E.slipReport(legs.map(l => ({ name: l.fixture, P: l.P, league: l.league })), state.settings)
      : E.poolsSlipReport(legs.map(l => ({ name: l.fixture, P: l.P })));
    const coupon = document.getElementById(`${prefix}-coupon-name`).value.trim();
    const stakeRs = numOrNull(document.getElementById(`${prefix}-stake`).value);
    const ticket = makeTicket({ game: mode, coupon, stakeRs, legs, slipStats });
    state.tickets.unshift(ticket);
    save();
    picks[mode].clear();
    renderAll(mode);
    renderTickets();
    toast(`Ticket saved (${legs.length} legs). Grade it later from History & Calibration.`);
  });
}

function wireLogPastTicket() {
  document.getElementById('log-past-btn').addEventListener('click', () => {
    const text = document.getElementById('log-past-input').value.trim();
    const msg = document.getElementById('log-past-msg');
    if (!text) { msg.classList.add('error'); msg.textContent = 'Paste a coupon JSON first.'; return; }
    try {
      const payload = JSON.parse(text);
      const game = payload.game === 'pools' ? 'pools' : 'btts';
      const rawLegs = Array.isArray(payload.legs) ? payload.legs : [];
      if (rawLegs.length === 0) throw new Error('No "legs" array found.');

      const legs = rawLegs.map((l, idx) => ({
        id: l.match_no != null ? `p_m${l.match_no}` : `p_${l.fixture}_${idx}`,
        match_no: l.match_no ?? null,
        fixture: l.fixture || 'Unknown fixture',
        league: l.league || 'Unknown',
        P: numOrNull(l.P) ?? (game === 'btts' ? 0.65 : 0.16),
      }));

      const slipStats = game === 'btts'
        ? E.slipReport(legs.map(l => ({ name: l.fixture, P: l.P, league: l.league })), state.settings)
        : E.poolsSlipReport(legs.map(l => ({ name: l.fixture, P: l.P })));

      const ticket = makeTicket({
        game, coupon: payload.coupon || '', stakeRs: numOrNull(payload.stakeRs), legs, slipStats,
      });
      state.tickets.unshift(ticket);

      // Grade immediately using the same objects (they already carry score/btts/status).
      gradeTicket(ticket.id, { results: rawLegs.map((l, idx) => ({ ...l, match_no: l.match_no ?? null, fixture: l.fixture || legs[idx].fixture })) });

      save();
      msg.classList.remove('error');
      msg.textContent = `Logged and graded a ${legs.length}-leg ${game === 'btts' ? 'Goal Rush' : 'Classic Pools'} ticket.`;
      document.getElementById('log-past-input').value = '';
      renderTickets();
      renderCalibration();
      toast('Past coupon logged and graded.');
    } catch (e) {
      msg.classList.add('error');
      msg.textContent = `Could not log: ${e.message}`;
    }
  });

  document.getElementById('log-past-template-btn').addEventListener('click', () => {
    downloadJSON(PAST_TICKET_TEMPLATE, 'past-coupon-template.json');
  });
}

function ticketHeaderLine(t) {
  const d = new Date(t.created).toLocaleDateString();
  const gameLabel = t.game === 'btts' ? 'Goal Rush' : 'Classic Pools';
  return `${gameLabel} · ${t.legs.length} legs · ${d}${t.coupon ? ' · ' + esc(t.coupon) : ''}${t.stakeRs ? ' · Rs ' + t.stakeRs : ''}`;
}

function renderTickets() {
  const el = document.getElementById('tickets-list');
  if (state.tickets.length === 0) { el.innerHTML = '<p class="hint">No tickets saved yet.</p>'; return; }

  el.innerHTML = state.tickets.map(t => {
    const legsRows = t.legs.map(l => {
      const g = t.graded && t.graded.legMap ? t.graded.legMap[l.id] : null;
      const gtxt = g ? (g.hit === true ? '✅' : g.hit === false ? '❌' : g.colour ? g.colour : '—') : '';
      return `<tr><td>${l.match_no ?? ''}</td><td>${esc(l.fixture)}</td><td>${esc(l.league)}</td><td>${(l.P * 100).toFixed(1)}%</td><td>${gtxt}</td></tr>`;
    }).join('');

    const gradedSummary = t.graded ? `
      <div class="grade-summary">
        ${t.game === 'btts'
          ? `<strong>${t.graded.hits}/${t.graded.resolved} resolved hit.</strong> ${t.graded.resolved < t.legs.length ? `(${t.legs.length - t.graded.resolved} still unresolved)` : ''}`
          : `<strong>${t.graded.totalPoints} pts</strong> — GREEN ${t.graded.green}, BLUE ${t.graded.blue}, RED ${t.graded.red}, VOID ${t.graded.voidCount}.`}
        ${t.graded.note ? `<div class="hint">${esc(t.graded.note)}</div>` : ''}
      </div>` : '';

    return `<div class="ticket" data-tid="${t.id}">
      <div class="ticket-header">
        <span>${ticketHeaderLine(t)}</span>
        <span class="${t.status === 'graded' ? 'status-graded' : 'status-pending'}">${t.status.toUpperCase()}</span>
      </div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Fixture</th><th>League</th><th>P</th><th>Result</th></tr></thead>
      <tbody>${legsRows}</tbody></table></div>
      ${gradedSummary}
      <details><summary class="hint">Paste results to grade</summary>
        <textarea rows="4" class="grade-input" placeholder='{"results":[{"match_no":1,"fixture":"Home v Away","score":"2-1","btts":"YES","status":"FT"}, ...]}'></textarea>
        <div class="btn-row">
          <button class="btn btn-primary small-btn grade-btn">Grade</button>
          <button class="btn btn-ghost small-btn template-btn">Download results template</button>
          <button class="btn btn-danger small-btn delete-btn">Delete ticket</button>
        </div>
      </details>
    </div>`;
  }).join('');

  el.querySelectorAll('.grade-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.ticket');
      const tid = card.dataset.tid;
      const text = card.querySelector('.grade-input').value.trim();
      if (!text) { toast('Paste a results JSON first.', true); return; }
      try {
        gradeTicket(tid, JSON.parse(text));
        save();
        renderTickets();
        renderCalibration();
        toast('Ticket graded.');
      } catch (err) {
        toast(`Could not grade: ${err.message}`, true);
      }
    });
  });

  el.querySelectorAll('.template-btn').forEach(btn => {
    btn.addEventListener('click', () => downloadJSON(RESULTS_TEMPLATE, 'results-template.json'));
  });

  el.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.ticket');
      const tid = card.dataset.tid;
      if (!confirm('Delete this ticket permanently?')) return;
      state.tickets = state.tickets.filter(t => t.id !== tid);
      save();
      renderTickets();
      renderCalibration();
    });
  });
}

function findResultFor(leg, resultsList) {
  return resultsList.find(r => (leg.match_no != null && r.match_no === leg.match_no))
    || resultsList.find(r => String(r.fixture || '').trim().toLowerCase() === String(leg.fixture).trim().toLowerCase());
}

function gradeTicket(ticketId, payload) {
  const ticket = state.tickets.find(t => t.id === ticketId);
  if (!ticket) throw new Error('Ticket not found.');
  const resultsList = Array.isArray(payload) ? payload : (payload.results || []);
  if (!Array.isArray(resultsList) || resultsList.length === 0) throw new Error('No "results" array found.');

  const legMap = {};
  if (ticket.game === 'btts') {
    let hits = 0, resolved = 0;
    for (const leg of ticket.legs) {
      const res = findResultFor(leg, resultsList);
      if (!res || res.status !== 'FT' || !res.btts) { legMap[leg.id] = { hit: null }; continue; }
      const hit = String(res.btts).toUpperCase() === 'YES';
      legMap[leg.id] = { hit, score: res.score };
      resolved++; if (hit) hits++;
    }
    ticket.graded = { hits, resolved, legMap, note: resolved < ticket.legs.length ? 'Some legs are still unresolved (missing/not FT).' : '' };
    ticket.status = resolved === ticket.legs.length ? 'graded' : 'pending';
  } else {
    let green = 0, blue = 0, red = 0, voidCount = 0, totalPoints = 0, resolved = 0;
    for (const leg of ticket.legs) {
      const res = findResultFor(leg, resultsList);
      if (!res) { legMap[leg.id] = { colour: null }; continue; }
      let colour, pts;
      if (res.status && res.status !== 'FT') {
        colour = 'VOID'; pts = 2; voidCount++;
      } else if (typeof res.score === 'string' && /^\d+\s*-\s*\d+$/.test(res.score.trim())) {
        const [h, a] = res.score.split('-').map(s => parseInt(s.trim(), 10));
        if (h === a) { if (h === 0) { colour = 'BLUE'; pts = 2; blue++; } else { colour = 'GREEN'; pts = 3; green++; } }
        else { colour = 'RED'; pts = 1; red++; }
      } else { legMap[leg.id] = { colour: null }; continue; }
      legMap[leg.id] = { colour, score: res.score };
      totalPoints += pts; resolved++;
    }
    ticket.graded = { green, blue, red, voidCount, totalPoints, resolved, legMap, note: resolved < ticket.legs.length ? 'Some legs are still unresolved.' : '' };
    ticket.status = resolved === ticket.legs.length ? 'graded' : 'pending';
  }
}

// ----------------------------------------------------------------------
// CALIBRATION + LEAGUE TRACK RECORD
// ----------------------------------------------------------------------
function renderCalibration() {
  const buckets = [];
  for (let lo = 0.50; lo < 1.0; lo += 0.05) buckets.push({ lo, hi: lo + 0.05, n: 0, hits: 0 });

  const leagueStats = {}; // league -> {n, hits, greenN, greenHits}

  for (const t of state.tickets) {
    if (!t.graded) continue;
    for (const leg of t.legs) {
      const g = t.graded.legMap[leg.id];
      if (!g) continue;
      leagueStats[leg.league] = leagueStats[leg.league] || { btts_n: 0, btts_hits: 0, pools_n: 0, pools_green: 0 };
      if (t.game === 'btts') {
        if (g.hit === null || g.hit === undefined) continue;
        const b = buckets.find(b => leg.P >= b.lo && leg.P < b.hi + 1e-9);
        if (b) { b.n++; if (g.hit) b.hits++; }
        leagueStats[leg.league].btts_n++;
        if (g.hit) leagueStats[leg.league].btts_hits++;
      } else {
        if (!g.colour) continue;
        leagueStats[leg.league].pools_n++;
        if (g.colour === 'GREEN') leagueStats[leg.league].pools_green++;
      }
    }
  }

  const calTable = document.getElementById('calibration-table');
  calTable.querySelector('thead').innerHTML = '<tr><th>Predicted P(BTTS) bucket</th><th>Graded legs</th><th>Actual hit rate</th></tr>';
  const calRows = buckets.filter(b => b.n > 0).map(b =>
    `<tr><td>${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%</td><td>${b.n}</td><td>${((b.hits / b.n) * 100).toFixed(1)}%</td></tr>`
  ).join('');
  calTable.querySelector('tbody').innerHTML = calRows || '<tr><td colspan="3" class="hint">No graded BTTS legs yet.</td></tr>';

  const trackTable = document.getElementById('league-track-table');
  trackTable.querySelector('thead').innerHTML = '<tr><th>League</th><th>Prior BTTS base</th><th>Empirical BTTS hit rate</th><th>Empirical GREEN rate</th></tr>';
  const rows = Object.entries(leagueStats).map(([lg, s]) => {
    const prior = state.leagues[lg] ? `${(state.leagues[lg].base * 100).toFixed(0)}%` : '—';
    const empBtts = s.btts_n > 0 ? `${((s.btts_hits / s.btts_n) * 100).toFixed(1)}% (n=${s.btts_n})` : '—';
    const empGreen = s.pools_n > 0 ? `${((s.pools_green / s.pools_n) * 100).toFixed(1)}% (n=${s.pools_n})` : '—';
    const sortKey = s.btts_n > 0 ? s.btts_hits / s.btts_n : (s.pools_n > 0 ? s.pools_green / s.pools_n : -1);
    return { lg, prior, empBtts, empGreen, sortKey };
  }).sort((a, b) => b.sortKey - a.sortKey);

  trackTable.querySelector('tbody').innerHTML = rows.map(r =>
    `<tr><td>${esc(r.lg)}</td><td>${r.prior}</td><td>${r.empBtts}</td><td>${r.empGreen}</td></tr>`
  ).join('') || '<tr><td colspan="4" class="hint">Grade some tickets to build a track record.</td></tr>';
}

// ----------------------------------------------------------------------
// SETTINGS TAB — leagues table + engine settings + reference panels
// ----------------------------------------------------------------------
const SETTINGS_FIELDS = [
  { key: 'rho', label: 'Dixon-Coles ρ', step: 0.01 },
  { key: 'k', label: 'Shrinkage k', step: 0.5 },
  { key: 'w', label: 'Humility blend w', step: 0.05 },
  { key: 'safe', label: 'Safe leg threshold (BTTS)', step: 0.01 },
  { key: 'gammaSd', label: 'MC gamma sd', step: 0.01 },
  { key: 'mcIter', label: 'MC iterations', step: 1000 },
  { key: 'maxLegsPerLeague', label: 'Max legs / league', step: 1 },
  { key: 'poolsGapThreshold', label: 'Pools GAP threshold', step: 0.01 },
  { key: 'poolsXgLow', label: 'Pools XG window low', step: 0.1 },
  { key: 'poolsXgHigh', label: 'Pools XG window high', step: 0.1 },
  { key: 'poolsZeroZeroRisk', label: 'Pools 0-0 risk ceiling', step: 0.01 },
  { key: 'poolsSafeThreshold', label: 'Pools safe threshold', step: 0.01 },
];

function renderSettingsForm() {
  const el = document.getElementById('settings-form');
  el.innerHTML = SETTINGS_FIELDS.map(f => `
    <div><label>${esc(f.label)}</label>
      <input type="number" step="${f.step}" data-key="${f.key}" value="${state.settings[f.key]}"></div>
  `).join('');
  el.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (Number.isFinite(v)) { state.settings[inp.dataset.key] = v; save(); renderAll(); }
    });
  });
}

function renderLeaguesTable() {
  const table = document.getElementById('leagues-table');
  table.querySelector('thead').innerHTML = `<tr><th>League</th><th>Base</th><th>HG</th><th>AG</th><th>Delta</th><th>Tier</th><th>Note</th><th></th></tr>`;
  const names = Object.keys(state.leagues).sort();
  table.querySelector('tbody').innerHTML = names.map(name => {
    const L = state.leagues[name];
    return `<tr data-league="${esc(name)}">
      <td>${esc(name)}</td>
      <td><input type="number" step="0.01" class="lf" data-field="base" value="${L.base}"></td>
      <td><input type="number" step="0.05" class="lf" data-field="hg" value="${L.hg}"></td>
      <td><input type="number" step="0.05" class="lf" data-field="ag" value="${L.ag}"></td>
      <td><input type="number" step="0.01" class="lf" data-field="delta" value="${L.delta === null ? '' : L.delta}" placeholder="AVOID"></td>
      <td><select class="lf" data-field="tier">
        ${['high_core', 'mid', 'low_avoid', 'unknown'].map(t => `<option value="${t}" ${L.tier === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select></td>
      <td><input type="text" class="lf" data-field="note" value="${esc(L.note || '')}"></td>
      <td><button class="btn btn-danger small-btn del-league">×</button></td>
    </tr>`;
  }).join('');

  table.querySelectorAll('.lf').forEach(inp => {
    inp.addEventListener('change', () => {
      const row = inp.closest('tr');
      const name = row.dataset.league;
      const field = inp.dataset.field;
      let val = inp.value;
      if (field === 'base' || field === 'hg' || field === 'ag') val = Number(val);
      else if (field === 'delta') val = val === '' ? null : Number(val);
      state.leagues[name][field] = val;
      save();
      renderAll();
    });
  });

  table.querySelectorAll('.del-league').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.closest('tr').dataset.league;
      if (!confirm(`Remove "${name}" from the league table?`)) return;
      delete state.leagues[name];
      save();
      renderLeaguesTable();
      renderAll();
    });
  });
}

function renderReferencePanels() {
  document.getElementById('payout-reference').innerHTML = `
    <div class="table-wrap"><table><thead><tr><th>Coupon tail</th><th>Tier</th><th>Payout</th></tr></thead>
    <tbody>${PAYOUT_REFERENCE.empirical.map(p => `<tr><td>${esc(p.tail)}</td><td>${p.tier}</td><td>Rs ${p.payoutRs}</td></tr>`).join('')}</tbody></table></div>
    <div class="table-wrap"><table><thead><tr><th>Safe legs on 35-board</th><th>Read</th><th>Staking</th></tr></thead>
    <tbody>${PAYOUT_REFERENCE.dilutionCurve.map(d => `<tr><td>${esc(d.safeLegsOn35)}</td><td>${esc(d.read)}</td><td>${esc(d.staking)}</td></tr>`).join('')}</tbody></table></div>
    <p class="hint">Historic ranges — Goal Rush 8/8: ${PAYOUT_REFERENCE.historicDividendRanges.goalRush8of8}; 7/8: ${PAYOUT_REFERENCE.historicDividendRanges.goalRush7of8}; Classic Pools (24pts): ${PAYOUT_REFERENCE.historicDividendRanges.classicPools24pts}; Premier 10: ${PAYOUT_REFERENCE.historicDividendRanges.premier10}.</p>
  `;

  document.getElementById('pools-reference').innerHTML = `
    <div class="table-wrap"><table><thead><tr><th>Colour</th><th>Outcome</th><th>Points</th></tr></thead>
    <tbody>${CLASSIC_POOLS_REFERENCE.scoring.map(s => `<tr><td>${s.colour}</td><td>${esc(s.outcome)}</td><td>${s.points}</td></tr>`).join('')}</tbody></table></div>
    <p class="hint">Target metric: ${esc(CLASSIC_POOLS_REFERENCE.targetMetric)}. Base rate: ${esc(CLASSIC_POOLS_REFERENCE.baseRate)}</p>
  `;

  document.getElementById('pipeline-notes').innerHTML = `<p class="hint">${esc(REQUIRED_FIELDS_NOTE)}</p>
    <p class="hint">Gemini rule: raw-numbers collector only, never a verdict provider — it has masked filter exclusions and mis-estimated BTTS% before. Cross-check any raw percentage against this engine's filter stack.</p>`;
}

// ----------------------------------------------------------------------
// WIRE STATIC BUTTONS
// ----------------------------------------------------------------------
document.getElementById('btts-autopick-btn').addEventListener('click', autopickBtts);
document.getElementById('btts-clearpick-btn').addEventListener('click', () => { picks.btts.clear(); renderAll('btts'); });
document.getElementById('pools-autopick-btn').addEventListener('click', autopickPools);
document.getElementById('pools-clearpick-btn').addEventListener('click', () => { picks.pools.clear(); renderAll('pools'); });

document.getElementById('league-add-btn').addEventListener('click', () => {
  const name = prompt('League name:');
  if (!name) return;
  if (state.leagues[name]) { toast('That league already exists.', true); return; }
  state.leagues[name] = { ...DEFAULT_LEAGUE_FALLBACK, note: '' };
  save();
  renderLeaguesTable();
});
document.getElementById('league-reset-btn').addEventListener('click', () => {
  if (!confirm('Reset all league data to the shipped defaults? Custom leagues you added will be lost.')) return;
  state.leagues = JSON.parse(JSON.stringify(DEFAULT_LEAGUES));
  save();
  renderLeaguesTable();
  renderAll();
});
document.getElementById('settings-reset-btn').addEventListener('click', () => {
  if (!confirm('Reset engine settings to defaults?')) return;
  state.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  save();
  renderSettingsForm();
  renderAll();
});

document.getElementById('export-btn').addEventListener('click', () => {
  exportState(state);
  toast('Backup downloaded.');
});
document.getElementById('import-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state = importStateFromText(reader.result);
      save();
      document.getElementById('backup-status').textContent = `Imported backup from ${file.name}.`;
      renderEverything();
      toast('Backup imported.');
    } catch (err) {
      toast(`Import failed: ${err.message}`, true);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});
document.getElementById('reset-app-btn').addEventListener('click', () => {
  if (!confirm('This clears ALL boards, tickets and settings from this browser. Export a backup first if unsure. Continue?')) return;
  state = resetState();
  picks.btts.clear(); picks.pools.clear();
  renderEverything();
  toast('App reset.');
});

// ----------------------------------------------------------------------
// INIT
// ----------------------------------------------------------------------
function renderEverything() {
  renderAll();
  renderTickets();
  renderCalibration();
  renderLeaguesTable();
  renderSettingsForm();
  renderReferencePanels();
}

wireBoardInput('btts', 'bttsBoard', 'btts');
wireBoardInput('pools', 'poolsBoard', 'pools');
wireTicketSave('btts', 'btts');
wireTicketSave('pools', 'pools');
wireLogPastTicket();
wireTeamPicker('btts', 'bttsBoard', 'btts');
wireTeamPicker('pools', 'poolsBoard', 'pools');
wireQuickPasteNames('btts', 'bttsBoard', 'btts');
wireQuickPasteNames('pools', 'poolsBoard', 'pools');

renderEverything();
initEuroData();
