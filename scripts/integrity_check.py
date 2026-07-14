#!/usr/bin/env python3
"""
integrity_check.py — periodic data-integrity spot-check for the Pools app.

WHY THIS EXISTS
----------------
The self-improvement job (self_improve.py) tunes calibration deltas assuming
the underlying league/team data itself is honest. That's not a safe
assumption to hold forever: data could be corrupted by accident (like the
world2_2025-26.json raw-count-vs-percentage bug found 14 Jul 2026), or -- the
concern this script specifically exists for -- tampered with on purpose by
someone wanting to jeopardize the app's predictions (a compromised upstream
source, a bad commit, a malicious PR to a data file, etc). This script does
NOT assume "the database" is true. It checks it.

WHAT THIS DOES
---------------
1. STRUCTURAL/STATISTICAL CONSISTENCY CHECKS (deterministic, no network,
   runs against every league and every team in the four deployed data
   files). These are mathematical invariants that MUST hold if the numbers
   are honest -- violating them means corruption or fabrication, not just
   "an unusual season":
     - score_draw% + nil_nil% + decisive% ~= 100%  (complete partition of results)
     - btts% <= 100% - nil_nil%                     (a 0-0 can't also be BTTS)
     - avg_goals ~= home_gf + away_gf                (internal arithmetic consistency)
     - goal rates (home_gf/away_gf/h_gf/h_ga/a_gf/a_ga) within a plausible
       0-8 goals/match band
     - team-level: h_btts% <= h_sr%                  (BTTS requires this team scored)
     - team-level: h_btts% <= 100% - h_cs%            (a clean sheet rules out BTTS)
       (same four checks mirrored for the away side: a_btts/a_sr/a_cs)

2. RANDOM SAMPLE FOR EXTERNAL CROSS-CHECK. Picks a small random sample of
   leagues (default 3) each run and prints them clearly. This script does
   NOT itself verify them against the outside world -- it has no reliable
   web-search capability of its own. The calling agent (a real Claude turn,
   either interactive or the weekly scheduled task) is expected to take this
   printed sample and independently verify each one via WebSearch (e.g.
   "does <league name> <season> exist, is the team list plausible, does
   the general scoring character roughly match independent reporting") and
   append the outcome to data/integrity_log.json under "external_checks".
   This split exists because parsing arbitrary web results well is an agent
   task, not something a brittle deterministic script should attempt.

3. Writes data/integrity_log.json -- append-only audit trail. This script
   FLAGS problems, it does not auto-correct them. Auto-"fixing" a suspected
   integrity issue from inside the same automated pipeline that might have
   caused it (or might itself be compromised) defeats the point of a check;
   a flagged file should get a human look, same as the world2 bug did.

USAGE
-----
    python3 integrity_check.py [--live-base URL] [--sample-size N] [--seed N]
"""

import argparse
import json
import random
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
LOG_PATH = REPO_ROOT / "data" / "integrity_log.json"

TOL_PCT = 3.0        # percentage-point tolerance on partition/bound checks (rounding slack)
TOL_GOALS = 0.35      # tolerance on avg_goals ~= home_gf + away_gf
GOAL_RATE_MIN, GOAL_RATE_MAX = 0.0, 8.0
MAX_LOG_ENTRIES = 200


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def load_log():
    if LOG_PATH.exists():
        try:
            return json.loads(LOG_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"_meta": {"schema": 1, "last_run": None, "run_count": 0}, "runs": []}


def check_league(code, meta):
    problems = []
    n = meta.get("n")
    if not n or n <= 0:
        problems.append(f"n missing or non-positive ({n})")
        return problems  # nothing else is checkable without n

    for field in ("btts", "score_draw", "nil_nil", "decisive"):
        v = meta.get(field)
        if v is None:
            problems.append(f"{field} missing")
        elif not (0 - TOL_PCT <= v <= 100 + TOL_PCT):
            problems.append(f"{field}={v} out of [0,100] range")

    sd, nn, dec = meta.get("score_draw"), meta.get("nil_nil"), meta.get("decisive")
    if None not in (sd, nn, dec):
        total = sd + nn + dec
        if abs(total - 100) > TOL_PCT:
            problems.append(f"score_draw+nil_nil+decisive={total:.1f}, expected ~100 (partition must be complete)")

    btts, nn2 = meta.get("btts"), meta.get("nil_nil")
    if btts is not None and nn2 is not None:
        if btts > (100 - nn2) + TOL_PCT:
            problems.append(f"btts={btts} exceeds 100-nil_nil={100-nn2:.1f} (a 0-0 match cannot count as BTTS)")

    hg, ag = meta.get("home_gf"), meta.get("away_gf")
    for label, v in (("home_gf", hg), ("away_gf", ag)):
        if v is not None and not (GOAL_RATE_MIN <= v <= GOAL_RATE_MAX):
            problems.append(f"{label}={v} outside plausible [{GOAL_RATE_MIN},{GOAL_RATE_MAX}] goals/match band")

    avg_goals = meta.get("avg_goals")
    if avg_goals is not None and hg is not None and ag is not None:
        if abs(avg_goals - (hg + ag)) > TOL_GOALS:
            problems.append(f"avg_goals={avg_goals} but home_gf+away_gf={hg+ag:.2f} (should roughly match)")

    return problems


def check_team(code, name, t):
    problems = []
    for side, p_key in (("h", "h_p"), ("a", "a_p")):
        p = t.get(p_key)
        if p is None or p < 0:
            problems.append(f"{p_key} missing/negative")
            continue
        gf, ga = t.get(f"{side}_gf"), t.get(f"{side}_ga")
        for label, v in ((f"{side}_gf", gf), (f"{side}_ga", ga)):
            if v is not None and not (GOAL_RATE_MIN <= v <= GOAL_RATE_MAX):
                problems.append(f"{label}={v} outside plausible goals/match band")
        cs, sr, btts = t.get(f"{side}_cs"), t.get(f"{side}_sr"), t.get(f"{side}_btts")
        for label, v in ((f"{side}_cs", cs), (f"{side}_sr", sr), (f"{side}_btts", btts)):
            if v is not None and not (0 - TOL_PCT <= v <= 100 + TOL_PCT):
                problems.append(f"{label}={v} out of [0,100] range")
        if btts is not None and sr is not None and btts > sr + TOL_PCT:
            problems.append(f"{side}_btts={btts} exceeds {side}_sr={sr} (BTTS requires this team to have scored)")
        if btts is not None and cs is not None and btts > (100 - cs) + TOL_PCT:
            problems.append(f"{side}_btts={btts} exceeds 100-{side}_cs={100-cs:.1f} (a clean sheet rules out BTTS)")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live-base", default=LIVE_BASE_DEFAULT)
    ap.add_argument("--sample-size", type=int, default=3)
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    print(f"Fetching live league data from {args.live_base} ...")
    all_leagues, all_teams = {}, {}
    for path in DATA_FILES:
        url = f"{args.live_base}/{path}"
        try:
            d = fetch_json(url)
        except Exception as e:
            print(f"  WARN: failed to fetch {url}: {e}", file=sys.stderr)
            continue
        all_leagues.update(d.get("leagues", {}))
        all_teams.update(d.get("teams", {}))

    if not all_leagues:
        print("ERROR: no league data fetched -- aborting.", file=sys.stderr)
        sys.exit(1)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    league_flags = {}
    team_flag_count = 0
    checked_teams = 0

    for code, meta in sorted(all_leagues.items()):
        problems = check_league(code, meta)
        if problems:
            league_flags[code] = {"name": meta.get("name", code), "problems": problems}
        team_problems_for_league = []
        for name, t in all_teams.get(code, {}).items():
            checked_teams += 1
            tp = check_team(code, name, t)
            if tp:
                team_flag_count += 1
                team_problems_for_league.append({"team": name, "problems": tp})
        if team_problems_for_league:
            league_flags.setdefault(code, {"name": meta.get("name", code), "problems": []})
            league_flags[code]["team_problems"] = team_problems_for_league

    # Random sample for external (agent-driven) cross-check.
    rng = random.Random(args.seed)
    codes = sorted(all_leagues.keys())
    sample_codes = rng.sample(codes, min(args.sample_size, len(codes)))
    sample = [{"code": c, "name": all_leagues[c].get("name", c), "n": all_leagues[c].get("n")} for c in sample_codes]

    print(f"\nChecked {len(all_leagues)} leagues, {checked_teams} teams.")
    print(f"Structural flags: {len(league_flags)} league(s) with issues, {team_flag_count} team-level issue(s) total.")
    if league_flags:
        print("\nFLAGGED (needs manual review, NOT auto-corrected):")
        for code, info in league_flags.items():
            print(f"  {code} ({info['name']}):")
            for p in info.get("problems", []):
                print(f"      - {p}")
            for tp in info.get("team_problems", [])[:5]:
                print(f"      - team '{tp['team']}': {tp['problems']}")
            if len(info.get("team_problems", [])) > 5:
                print(f"      ... and {len(info['team_problems']) - 5} more team(s)")

    print(f"\nRANDOM SAMPLE for external cross-check this cycle (seed={args.seed}):")
    for s in sample:
        print(f"  {s['code']}: {s['name']} (n={s['n']} matches)")
    print("\n  -> The calling agent should WebSearch each of these to confirm the league/season")
    print("     genuinely exists and the general scoring character isn't contradicted by")
    print("     independent reporting, then record the outcome in data/integrity_log.json")
    print("     under this run's \"external_checks\" (see run entry appended below).")

    log = load_log()
    log["_meta"]["last_run"] = today
    log["_meta"]["run_count"] = log["_meta"].get("run_count", 0) + 1
    run_entry = {
        "date": today,
        "leagues_checked": len(all_leagues),
        "teams_checked": checked_teams,
        "structural_flags": league_flags,
        "random_sample_for_external_check": sample,
        "external_checks": [],  # the calling agent fills this in after WebSearch verification
    }
    log.setdefault("runs", []).append(run_entry)
    log["runs"] = log["runs"][-MAX_LOG_ENTRIES:]

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOG_PATH.write_text(json.dumps(log, indent=2, ensure_ascii=False) + "\n")
    print(f"\nWrote {LOG_PATH} (run #{log['_meta']['run_count']})")

    if league_flags:
        print("\nEXIT STATUS: issues found -- review before trusting this cycle's calibration tuning for the flagged leagues.")
        sys.exit(2)


if __name__ == "__main__":
    main()
