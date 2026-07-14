#!/usr/bin/env python3
"""
self_improve.py — weekly self-calibration job for the Pools BTTS engine.

WHAT THIS DOES
---------------
For every auto-ingested league (the ones eurodata.js merges in via
mergeEuroLeaguesInto — i.e. everything in euro_2025-26.json,
world_2025-26.json, world2_2025-26.json, international_2025-26.json), this
script:

  1. Fetches the CURRENTLY LIVE deployed league JSON files from GitHub Pages
     (the same files the app itself reads at runtime).
  2. For each league, computes what the Dixon-Coles engine ITSELF would say
     the league's BTTS rate should be, using the league's own average
     home/away goal rates as a league-average-vs-league-average fixture
     (lh = home_gf, la = away_gf — this is the same simplification as an
     "average team at home vs average team away" matchup, which is exactly
     what home_gf/away_gf already represent).
  3. Compares that model-implied rate to the EMPIRICAL btts rate already
     recorded for that league (real observed matches this season).
  4. Nudges league.delta — the calibration offset engine.js already applies
     in evaluateBTTS() as `P += league.delta * 0.5` — by a bounded step
     toward closing that gap. Bounded to +/-0.03 per cycle, +/-0.15 total,
     so one noisy week (or a league with too few matches) can't swing
     calibration on its own.
  5. Writes data/calibration.json with the updated deltas + an audit-trail
     changelog entry per league touched this cycle.

WHAT THIS DELIBERATELY DOES NOT DO (yet)
-----------------------------------------
It does not re-run the openfootball ingestion pipeline to pull in brand new
match results — it re-calibrates against whatever the four league JSON files
currently contain. If a league's underlying data hasn't changed since last
cycle, the gap will already be ~0 and the delta will correctly stop moving —
that's the loop converging, not the loop being broken. Wiring in a periodic
re-fetch of the underlying match data (so the empirical rates themselves
refresh, not just the calibration against them) is the natural next step —
see the TODO at the bottom.

USAGE
-----
    python3 self_improve.py [--dry-run] [--live-base URL]

    --dry-run     Compute and print everything, but don't write calibration.json.
    --live-base   Override the base URL for the live site (default: the
                  deployed GitHub Pages URL). Useful for testing against a
                  local copy of data/ before deploying.
"""

import argparse
import json
import math
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LIVE_BASE_DEFAULT = "https://mfdjcbgjpf-spec.github.io/pools"
DATA_FILES = [
    "data/euro_2025-26.json",
    "data/world_2025-26.json",
    "data/world2_2025-26.json",
    "data/international_2025-26.json",
]

REPO_ROOT = Path(__file__).resolve().parent.parent
CALIBRATION_PATH = REPO_ROOT / "data" / "calibration.json"

# Must mirror js/data.js DEFAULT_SETTINGS.rho — if that constant changes,
# update this too (or better: fetch settings from a shared source later).
GLOBAL_RHO = -0.05

MIN_N = 15          # leagues with fewer matches than this are skipped (too noisy to trust)
MAX_STEP_PER_CYCLE = 0.03
MAX_TOTAL_DELTA = 0.15
LEARNING_RATE = 1.0  # target_delta = clip(LEARNING_RATE * 2 * gap, +/-MAX_TOTAL_DELTA); step is still bounded separately
MAX_CHANGELOG_ENTRIES = 500


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def factorial(n):
    r = 1
    for i in range(2, n + 1):
        r *= i
    return r


def pois(k, lam):
    return math.exp(-lam) * (lam ** k) / factorial(k)


def dc_matrix(lh, la, rho, size=9):
    """Direct port of engine.js's dcMatrix — same corrections, same normalization."""
    M = [[pois(i, lh) * pois(j, la) for j in range(size)] for i in range(size)]
    M[0][0] *= (1 - lh * la * rho)
    M[0][1] *= (1 + lh * rho)
    M[1][0] *= (1 + la * rho)
    M[1][1] *= (1 - rho)
    total = sum(sum(row) for row in M)
    for i in range(size):
        for j in range(size):
            M[i][j] /= total
    return M


def model_implied_btts(lh, la, rho):
    M = dc_matrix(lh, la, rho)
    return sum(M[i][j] for i in range(len(M)) for j in range(len(M)) if i > 0 and j > 0)


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def load_calibration():
    if CALIBRATION_PATH.exists():
        try:
            return json.loads(CALIBRATION_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"_meta": {"schema": 1, "last_run": None, "run_count": 0}, "leagues": {}, "changelog": []}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--live-base", default=LIVE_BASE_DEFAULT)
    args = ap.parse_args()

    print(f"Fetching live league data from {args.live_base} ...")
    all_leagues = {}
    for path in DATA_FILES:
        url = f"{args.live_base}/{path}"
        try:
            d = fetch_json(url)
        except Exception as e:
            print(f"  WARN: failed to fetch {url}: {e}", file=sys.stderr)
            continue
        n_leagues = len(d.get("leagues", {}))
        print(f"  {path}: {n_leagues} leagues")
        all_leagues.update(d.get("leagues", {}))

    if not all_leagues:
        print("ERROR: no league data fetched from any source — aborting without writing calibration.json.", file=sys.stderr)
        sys.exit(1)

    calibration = load_calibration()
    cal_leagues = calibration.setdefault("leagues", {})
    changelog = calibration.setdefault("changelog", [])

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    tuned, skipped_thin, skipped_noop, skipped_anomaly = 0, 0, 0, 0
    anomalies = []

    for code, meta in sorted(all_leagues.items()):
        n = meta.get("n", 0)
        btts_pct = meta.get("btts")
        hg = meta.get("home_gf")
        ag = meta.get("away_gf")
        if btts_pct is None or hg is None or ag is None:
            continue
        if n < MIN_N:
            skipped_thin += 1
            continue

        empirical_btts = btts_pct / 100.0

        # Sanity guard: a real BTTS rate can never be <=0 or >=1. If the source
        # data is malformed (e.g. a field stored as a raw count instead of a
        # percentage — this happened once, in world2_2025-26.json, and silently
        # fed nonsense deltas before this check existed), skip the league and
        # flag it for manual review instead of tuning on a garbage number.
        if not (0.03 <= empirical_btts <= 0.97):
            skipped_anomaly += 1
            anomalies.append((code, meta.get("name", code), btts_pct))
            print(f"  ANOMALY  {code:8s} {meta.get('name','')[:40]:40s} btts field={btts_pct} "
                  f"-> {empirical_btts:.3f} is out of plausible range — SKIPPED, needs manual review.")
            continue

        implied = model_implied_btts(hg, ag, GLOBAL_RHO)
        gap = empirical_btts - implied

        old_delta = cal_leagues.get(code, {}).get("delta", 0.0)
        target_delta = clamp(LEARNING_RATE * 2 * gap, -MAX_TOTAL_DELTA, MAX_TOTAL_DELTA)
        step = clamp(target_delta - old_delta, -MAX_STEP_PER_CYCLE, MAX_STEP_PER_CYCLE)
        new_delta = clamp(old_delta + step, -MAX_TOTAL_DELTA, MAX_TOTAL_DELTA)

        if abs(step) < 0.001:
            skipped_noop += 1

        cal_leagues[code] = {
            "delta": round(new_delta, 4),
            "last_tuned": today,
            "n": n,
            "empirical_btts": round(empirical_btts, 4),
            "model_implied_btts": round(implied, 4),
            "gap": round(gap, 4),
        }
        changelog.append({
            "date": today,
            "code": code,
            "league": meta.get("name", code),
            "n": n,
            "empirical_btts": round(empirical_btts, 4),
            "model_implied_btts": round(implied, 4),
            "gap": round(gap, 4),
            "old_delta": round(old_delta, 4),
            "new_delta": round(new_delta, 4),
            "step": round(step, 4),
        })
        tuned += 1
        print(f"  {code:8s} {meta.get('name','')[:40]:40s} n={n:4d}  empirical={empirical_btts:.3f}  "
              f"model={implied:.3f}  gap={gap:+.3f}  delta {old_delta:+.3f} -> {new_delta:+.3f}")

    changelog[:] = changelog[-MAX_CHANGELOG_ENTRIES:]
    calibration["_meta"]["last_run"] = today
    calibration["_meta"]["run_count"] = calibration["_meta"].get("run_count", 0) + 1
    calibration["_meta"]["description"] = (
        "Auto-tuned per-league BTTS calibration deltas, produced by the weekly "
        "self-improvement job (scripts/self_improve.py). Each cycle re-checks the "
        "Dixon-Coles model's implied BTTS rate against the league's actual observed "
        "BTTS rate this season and nudges delta by a bounded step to close the gap. "
        "Deltas are clamped to [-0.15, 0.15] and move at most 0.03 per cycle."
    )

    print(f"\nTuned {tuned} leagues ({skipped_noop} already converged), "
          f"skipped {skipped_thin} with n<{MIN_N}, skipped {skipped_anomaly} anomalies.")
    if anomalies:
        print("ANOMALIES requiring manual review (not auto-corrected, not tuned):")
        for code, name, raw in anomalies:
            print(f"    {code}: {name} — raw btts field = {raw}")

    if args.dry_run:
        print("\n--dry-run set: not writing calibration.json.")
        return

    CALIBRATION_PATH.parent.mkdir(parents=True, exist_ok=True)
    CALIBRATION_PATH.write_text(json.dumps(calibration, indent=2, ensure_ascii=False) + "\n")
    print(f"\nWrote {CALIBRATION_PATH}")


if __name__ == "__main__":
    main()

# TODO (next iteration, not yet built):
#   - Periodically re-run the openfootball ingestion pipeline (the same
#     parsers built 14 Jul 2026 for champions-league/copa-america/gold-cup/
#     internationals/worldcup.json/world) so home_gf/away_gf/btts themselves
#     refresh with newly completed matches, not just the calibration against
#     them. WC26 is a good first candidate — it's mid-tournament right now.
#   - Track calibration quality over time (is the gap trending toward 0
#     cycle over cycle, or oscillating?) and flag leagues where it isn't.
