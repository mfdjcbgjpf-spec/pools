// ============================================================================
// storage.js — localStorage persistence + JSON export/import
//
// Everything the app remembers lives under one key so export/import is a
// single round-trip. There is no server: this is what "sync between phone
// and web" means for now — export on one device, import on the other.
// ============================================================================

import { DEFAULT_LEAGUES, DEFAULT_SETTINGS } from './data.js';

const STORAGE_KEY = 'btts_pools_app_state_v1';
const SCHEMA_VERSION = 1;

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    leagues: JSON.parse(JSON.stringify(DEFAULT_LEAGUES)),
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    // Working boards (last pasted, before a slip is committed)
    bttsBoard: [],     // [{...fixture fields}]
    poolsBoard: [],
    // Saved coupons/fiches, pending or graded
    tickets: [],        // see makeTicket()
    lastUpdated: null,
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    // Shallow-merge with defaults so new fields introduced later don't crash old saves
    const base = emptyState();
    return {
      ...base,
      ...parsed,
      leagues: { ...base.leagues, ...(parsed.leagues || {}) },
      settings: { ...base.settings, ...(parsed.settings || {}) },
      tickets: Array.isArray(parsed.tickets) ? parsed.tickets : [],
      bttsBoard: Array.isArray(parsed.bttsBoard) ? parsed.bttsBoard : [],
      poolsBoard: Array.isArray(parsed.poolsBoard) ? parsed.poolsBoard : [],
    };
  } catch (e) {
    console.error('Failed to load saved state, starting fresh.', e);
    return emptyState();
  }
}

function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function resetState() {
  localStorage.removeItem(STORAGE_KEY);
  return emptyState();
}

function makeTicket({ id, game, coupon, stakeRs, legs, slipStats }) {
  return {
    id: id || `t_${Date.now()}`,
    game,                 // 'btts' | 'pools'
    coupon: coupon || '',
    created: new Date().toISOString(),
    stakeRs: stakeRs ?? null,
    legs,                  // [{match_no, fixture, league, P, ...}]
    slipStats,               // output of slipReport() / poolsSlipReport()
    status: 'pending',        // 'pending' | 'graded'
    graded: null,               // { legs: [{fixture, score, hit, ...}], hits, payoutRs, note }
  };
}

/** Trigger a browser download of the full state as a JSON file. */
function exportState(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `pools-app-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Parse an imported JSON file's text content into a valid state object. */
function importStateFromText(text) {
  const parsed = JSON.parse(text);
  const base = emptyState();
  return {
    ...base,
    ...parsed,
    leagues: { ...base.leagues, ...(parsed.leagues || {}) },
    settings: { ...base.settings, ...(parsed.settings || {}) },
    tickets: Array.isArray(parsed.tickets) ? parsed.tickets : [],
    bttsBoard: Array.isArray(parsed.bttsBoard) ? parsed.bttsBoard : [],
    poolsBoard: Array.isArray(parsed.poolsBoard) ? parsed.poolsBoard : [],
  };
}

export {
  STORAGE_KEY, emptyState, loadState, saveState, resetState,
  makeTicket, exportState, importStateFromText,
};
