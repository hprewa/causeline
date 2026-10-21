#!/usr/bin/env python3
"""Synthetic data generator for the contact-centre pack.

Stdlib only (random, csv, json, argparse, datetime). Writes to <out-dir> (default ./raw):
  calls.csv, agents.csv, faults.json

The organisation is 2 centres > 4 sites > 12 teams > 60 agents. Calls arrive in business hours,
heavier on weekdays, about 12,000 a week over 10 weeks; each call goes to a random agent and a
queue, and is answered within 20 seconds with a probability that depends on the queue and (slightly)
on the team. Handle time depends on the queue.

Faults are planted by name, by name (repeat --fault to combine):
  understaffed:team_05:wk7                 a team answers far fewer calls in time
  missing_logs:s_3:wk8                     most of a site's calls are missing from the data
  offset:team=team_01:team=team_02:wk6     one team gets worse while a sibling gets better
  block_outage:wk7:wed:12-14:0.25          a block of the day is bad, network-wide; the week looks normal
  slow_queue:billing:0.65                  a trait: that queue is answered in time 65% of the time
  reroute:*:billing:wk7:0.4                calls move to that queue and perform at its rate
  improve:wk7:0.1                          every queue gets better
  long_calls:team_09:wk7:1.5               a team's calls take 1.5x as long to handle
  surge:billing:wk7:0.5                    that queue gets 50% more calls
  surge_block:wk7:thu:14-17:0.6            a block of one day gets 60% more calls, on every queue

  surge_all:wk7:0.12                       every call may be repeated: a thin rise across every node
  star_agent:agent_007:0.99                a trait: that agent answers that share of calls in time
  bad_week:agent_007:wk4:0.12              one agent answers fewer calls in time in that week
  funnel:agent_007:wk7:0.45[:0.99]         that share of every other agent's calls go to that agent (answered at its own rate, or at the rate given)
  noisy_volume:0.08[:queue|team]           each week's volume moves by a random factor (sd 8%), for everything or for each queue or team on its own
  noisy_rate:0.02[:queue|team]             each week's service level moves by a random amount (sd 2 points), for everything or for each queue or team
  degrade:wk7:0.12                         every answered call may instead go unanswered in time: a thin worsening across every node
  ramp_down:wk10:0.35                      the newest weeks hold only that share of their calls (data still arriving)

Pure mix = slow_queue + reroute. Simpson's paradox = slow_queue + improve + reroute.
Order matters when combining: slow_queue first (reroute reuses its trait), then improve, then reroute.

Each run overwrites <out-dir> and writes faults.json recording exactly what was planted.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import re
from bisect import bisect
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from itertools import accumulate
from pathlib import Path
from typing import Callable

CENTRES = ["cc_1", "cc_2"]
SITES = {"s_1": "cc_1", "s_2": "cc_1", "s_3": "cc_2", "s_4": "cc_2"}  # site -> centre
TEAMS = {f"team_{i:02d}": f"s_{(i - 1) // 3 + 1}" for i in range(1, 13)}  # team -> site, 3 per site
AGENTS = {f"agent_{i:03d}": f"team_{(i - 1) // 5 + 1:02d}" for i in range(1, 61)}  # agent -> team, 5 per team

QUEUES = ["general", "billing", "tech", "sales"]
REASONS = ["question", "fault", "payment", "cancel", "other"]
MEAN_HANDLE = {"general": 280, "billing": 300, "tech": 420, "sales": 240}

BASE_SERVICE_LEVEL = 0.82
WEEK_START = datetime(2026, 1, 5)  # a Monday; week 1 starts here
TS_FORMAT = "%Y-%m-%d %H:%M:%S"
WEEKDAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
DAY_WEIGHTS = [1.0, 1.0, 1.0, 1.0, 1.0, 0.35, 0.25]  # arrivals per weekday, Monday first
HOURS = list(range(8, 20))
HOUR_WEIGHTS = [3, 5, 7, 8, 8, 7, 7, 8, 8, 7, 5, 3]  # two peaks, mid-morning and mid-afternoon

# --- seasonality -----------------------------------------------------------
# On top of the arrival pattern above (which was always there), with seasonality on (the default)
# service level and handle time follow the day and the calendar: slower over lunch, worse on Monday,
# a peak week and a holiday. All of it is declared in the ontology (time.seasonality) and found by
# onboarding; the runner must account for it. --no-seasonality restores the earlier flat rates.
SEASONAL = True
HOUR_SL_DELTA = {8: 0.03, 9: 0.03, 12: -0.05, 13: -0.05, 18: 0.02, 19: 0.02}  # added to the service level
WEEKDAY_SL_DELTA = [-0.03, 0.0, 0.0, 0.0, 0.01, 0.02, 0.02]  # Monday first
WEEKDAY_HANDLE = [1.08, 1.0, 1.0, 1.0, 0.97, 1.0, 1.0]  # multiplies handle time
PEAK_WEEK, PEAK_VOLUME, PEAK_SL_DELTA = 9, 1.3, -0.03
HOLIDAYS = {date(2026, 3, 10)}  # a Tuesday in week 10
HOLIDAY_VOLUME, HOLIDAY_SL_DELTA = 0.5, -0.04


def is_holiday(ts: datetime) -> bool:
    return SEASONAL and ts.date() in HOLIDAYS


def is_peak(ts: datetime) -> bool:
    return SEASONAL and week_of(ts) == PEAK_WEEK


def service_level_delta(ts: datetime) -> float:
    if not SEASONAL:
        return 0.0
    delta = HOUR_SL_DELTA.get(ts.hour, 0.0) + WEEKDAY_SL_DELTA[ts.weekday()]
    if is_peak(ts):
        delta += PEAK_SL_DELTA
    if is_holiday(ts):
        delta += HOLIDAY_SL_DELTA
    return delta


def site_of(agent: str) -> str:
    return TEAMS[AGENTS[agent]]


def centre_of(agent: str) -> str:
    return SITES[site_of(agent)]


def week_of(ts: datetime) -> int:
    return (ts - WEEK_START).days // 7 + 1


def fmt(ts: datetime) -> str:
    return ts.strftime(TS_FORMAT)


@dataclass
class Call:
    call_id: str
    ts: datetime
    agent: str
    queue: str
    reason: str
    answered: bool
    handle: float

    def to_row(self) -> dict:
        return {
            "call_id": self.call_id,
            "ts": fmt(self.ts),
            "agent": self.agent,
            "queue": self.queue,
            "call_reason": self.reason,
            "answered_within_20s": 1 if self.answered else 0,
            "handle_seconds": int(round(self.handle)),
            "is_holiday": 1 if is_holiday(self.ts) else 0,
            "is_peak": 1 if is_peak(self.ts) else 0,
        }


def generate_base(rng: random.Random, n_calls: int, n_weeks: int) -> list[Call]:
    team_effect = {team: rng.uniform(-0.02, 0.02) for team in TEAMS}  # fixed, small, keeps teams from being identical
    def day_weight(d: int) -> float:
        w = DAY_WEIGHTS[d % 7]
        if SEASONAL:
            day = WEEK_START + timedelta(days=d)
            if week_of(day) == PEAK_WEEK:
                w *= PEAK_VOLUME
            if day.date() in HOLIDAYS:
                w *= HOLIDAY_VOLUME
        return w

    day_cum = list(accumulate(day_weight(d) for d in range(n_weeks * 7)))
    hour_cum = list(accumulate(HOUR_WEIGHTS))
    agents = list(AGENTS)
    calls: list[Call] = []
    for i in range(1, n_calls + 1):
        day = bisect(day_cum, rng.random() * day_cum[-1])
        hour = HOURS[bisect(hour_cum, rng.random() * hour_cum[-1])]
        ts = WEEK_START + timedelta(days=day, hours=hour, minutes=rng.randrange(60), seconds=rng.randrange(60))
        agent = rng.choice(agents)
        queue = rng.choice(QUEUES)
        answered = rng.random() < BASE_SERVICE_LEVEL + team_effect[AGENTS[agent]] + service_level_delta(ts)
        mean = MEAN_HANDLE[queue] * (WEEKDAY_HANDLE[ts.weekday()] if SEASONAL else 1.0)
        calls.append(Call(f"CALL{i:07d}", ts, agent, queue, rng.choice(REASONS), answered, max(30.0, rng.gauss(mean, 0.35 * mean))))
    return calls


# ---------------------------------------------------------------------------
# Fault registry
# ---------------------------------------------------------------------------

# Extra probability of missing the 20-second target for a queue, set by slow_queue and reused by
# reroute so that calls moved onto that queue behave like its own. Cleared at the start of a run.
QUEUE_EXTRA_MISS: dict[str, float] = {}


def _parse_week_range(spec: str) -> tuple[int, int]:
    m = re.match(r"^wk(\d+)(?:-(\d+))?$", spec)
    if not m:
        raise ValueError(f"bad week spec {spec!r}, expected e.g. 'wk7' or 'wk6-8'")
    start = int(m.group(1))
    return start, int(m.group(2)) if m.group(2) else start


def _matches(call: Call, spec: str) -> bool:
    """A node spec: `team=team_01`, `site=s_1`, `centre=cc_1` (a bare name means a team)."""
    col, _, value = spec.rpartition("=")
    col = col or "team"
    if col == "agent":
        return call.agent == value
    if col == "team":
        return AGENTS[call.agent] == value
    if col == "site":
        return site_of(call.agent) == value
    if col == "centre":
        return centre_of(call.agent) == value
    raise ValueError(f"unknown node spec {spec!r}; use agent=..., team=..., site=... or centre=...")


Plant = Callable[[list[Call], list[str], random.Random], tuple[list[Call], dict]]


def plant_understaffed(calls, args, rng):
    team, week_spec = args
    w0, w1 = _parse_week_range(week_spec)
    n = 0
    for c in calls:
        if _matches(c, f"team={team}") and w0 <= week_of(c.ts) <= w1 and c.answered and rng.random() < 0.35:
            c.answered = False
            n += 1
    return calls, {"name": "understaffed", "args": {"team": team, "weeks": [w0, w1]}, "rows_affected": n}


def plant_missing_logs(calls, args, rng):
    site, week_spec = args
    w0, w1 = _parse_week_range(week_spec)
    kept, dropped = [], 0
    for c in calls:
        if site_of(c.agent) == site and w0 <= week_of(c.ts) <= w1 and rng.random() < 0.8:
            dropped += 1
            continue
        kept.append(c)
    return kept, {"name": "missing_logs", "args": {"site": site, "weeks": [w0, w1]}, "rows_affected": dropped}


def plant_offset(calls, args, rng):
    """offset:DOWN:UP:wkN -- DOWN answers about 9 points fewer calls in time, UP about 9 points more."""
    down, up, week_spec = args
    w0, w1 = _parse_week_range(week_spec)
    worse = better = 0
    for c in calls:
        if not (w0 <= week_of(c.ts) <= w1):
            continue
        if _matches(c, down) and c.answered and rng.random() < 0.11:
            c.answered = False
            worse += 1
        elif _matches(c, up) and not c.answered and rng.random() < 0.5:
            c.answered = True
            better += 1
    return calls, {"name": "offset", "args": {"down": down, "up": up, "weeks": [w0, w1]}, "rows_affected": worse + better}


def plant_block_outage(calls, args, rng):
    """block_outage:wkN:weekday:from-to:drop -- network-wide, in that block of that day."""
    week_spec, weekday, hours, drop = args
    w0, w1 = _parse_week_range(week_spec)
    day = WEEKDAYS[weekday.lower()]
    h0, h1 = (int(x) for x in hours.split("-"))
    p = float(drop)
    n = 0
    for c in calls:
        if w0 <= week_of(c.ts) <= w1 and c.ts.weekday() == day and h0 <= c.ts.hour < h1 and c.answered and rng.random() < p:
            c.answered = False
            n += 1
    return calls, {"name": "block_outage", "args": {"weeks": [w0, w1], "weekday": weekday, "hours": [h0, h1], "drop": p}, "rows_affected": n}


def plant_slow_queue(calls, args, rng):
    """slow_queue:QUEUE:rate -- a permanent trait, not an incident."""
    queue, rate_s = args
    extra = max(0.0, 1.0 - float(rate_s) / BASE_SERVICE_LEVEL)
    QUEUE_EXTRA_MISS[queue] = extra
    n = 0
    for c in calls:
        if c.queue == queue and c.answered and rng.random() < extra:
            c.answered = False
            n += 1
    return calls, {"name": "slow_queue", "args": {"queue": queue, "answered_in_time": float(rate_s)}, "rows_affected": n}


def plant_improve(calls, args, rng):
    week_spec, amount_s = args
    w0, w1 = _parse_week_range(week_spec)
    amount = float(amount_s)
    n = 0
    for c in calls:
        if w0 <= week_of(c.ts) <= w1 and not c.answered and rng.random() < amount:
            c.answered = True
            n += 1
    return calls, {"name": "improve", "args": {"weeks": [w0, w1], "amount": amount}, "rows_affected": n}


def plant_reroute(calls, args, rng):
    """reroute:FROM:TO:wkN:share -- FROM is a queue or `*` (every other queue). Rerouted calls
    perform at TO's own rate (see slow_queue), so no queue's rate changes -- only the mix does."""
    source, target, week_spec, share_s = args
    w0, w1 = _parse_week_range(week_spec)
    share = float(share_s)
    extra = QUEUE_EXTRA_MISS.get(target, 0.0)
    n = 0
    for c in calls:
        from_ok = (c.queue != target) if source == "*" else (c.queue == source)
        if from_ok and w0 <= week_of(c.ts) <= w1 and rng.random() < share:
            c.queue = target
            if c.answered and rng.random() < extra:
                c.answered = False
            n += 1
    return calls, {"name": "reroute", "args": {"from": source, "to": target, "weeks": [w0, w1], "share": share}, "rows_affected": n}


def plant_long_calls(calls, args, rng):
    team, week_spec, factor_s = args
    w0, w1 = _parse_week_range(week_spec)
    factor = float(factor_s)
    n = 0
    for c in calls:
        if _matches(c, f"team={team}") and w0 <= week_of(c.ts) <= w1:
            c.handle *= factor
            n += 1
    return calls, {"name": "long_calls", "args": {"team": team, "weeks": [w0, w1], "factor": factor}, "rows_affected": n}


def plant_surge(calls, args, rng):
    """surge:QUEUE:wkN:share -- that queue gets `share` more calls (copies of its calls, new ids)."""
    queue, week_spec, share_s = args
    w0, w1 = _parse_week_range(week_spec)
    share = float(share_s)
    extra: list[Call] = []
    for c in calls:
        if c.queue == queue and w0 <= week_of(c.ts) <= w1 and rng.random() < share:
            extra.append(Call(f"{c.call_id}S", c.ts + timedelta(seconds=rng.randrange(1, 600)), c.agent, c.queue, c.reason, c.answered, c.handle))
    return calls + extra, {"name": "surge", "args": {"queue": queue, "weeks": [w0, w1], "share": share}, "rows_affected": len(extra)}


def plant_surge_block(calls, args, rng):
    """surge_block:wkN:weekday:from-to:share -- that block of that day gets `share` more calls, on every queue."""
    week_spec, weekday, hours, share_s = args
    w0, w1 = _parse_week_range(week_spec)
    day = WEEKDAYS[weekday.lower()]
    h0, h1 = (int(x) for x in hours.split("-"))
    share = float(share_s)
    extra: list[Call] = []
    for c in calls:
        if w0 <= week_of(c.ts) <= w1 and c.ts.weekday() == day and h0 <= c.ts.hour < h1 and rng.random() < share:
            extra.append(Call(f"{c.call_id}B", c.ts + timedelta(seconds=rng.randrange(1, 600)), c.agent, c.queue, c.reason, c.answered, c.handle))
    return calls + extra, {"name": "surge_block", "args": {"weeks": [w0, w1], "weekday": weekday, "hours": [h0, h1], "share": share}, "rows_affected": len(extra)}


# A trait set by star_agent and reused by funnel so that calls moved to that agent are answered at its own rate.
AGENT_RATE: dict[str, float] = {}


def plant_surge_all(calls, args, rng):
    """surge_all:wkN:share -- every call is repeated with probability `share`: a thin rise across every node."""
    week_spec, share_s = args
    w0, w1 = _parse_week_range(week_spec)
    share = float(share_s)
    extra: list[Call] = []
    for c in calls:
        if w0 <= week_of(c.ts) <= w1 and rng.random() < share:
            extra.append(Call(f"{c.call_id}A", c.ts + timedelta(seconds=rng.randrange(1, 600)), c.agent, c.queue, c.reason, c.answered, c.handle))
    return calls + extra, {"name": "surge_all", "args": {"weeks": [w0, w1], "share": share}, "rows_affected": len(extra)}


def plant_star_agent(calls, args, rng):
    """star_agent:AGENT:rate -- a permanent trait: that agent's calls are answered in time with probability `rate`."""
    agent, rate_s = args
    rate = float(rate_s)
    AGENT_RATE[agent] = rate
    n = 0
    for c in calls:
        if c.agent == agent:
            c.answered = rng.random() < rate
            n += 1
    return calls, {"name": "star_agent", "args": {"agent": agent, "answered_in_time": rate}, "rows_affected": n}


def plant_bad_week(calls, args, rng):
    """bad_week:AGENT:wkN:drop -- that agent answers `drop` fewer calls in time in those weeks."""
    agent, week_spec, drop_s = args
    w0, w1 = _parse_week_range(week_spec)
    drop = float(drop_s)
    n = 0
    for c in calls:
        if c.agent == agent and w0 <= week_of(c.ts) <= w1 and c.answered and rng.random() < drop:
            c.answered = False
            n += 1
    return calls, {"name": "bad_week", "args": {"agent": agent, "weeks": [w0, w1], "drop": drop}, "rows_affected": n}


def plant_funnel(calls, args, rng):
    """funnel:AGENT:wkN:share[:rate] -- `share` of every other agent's calls go to AGENT and are answered at AGENT's own rate (see star_agent),
    or at `rate` when given (the agent answers better, or worse, in those weeks than it usually does)."""
    agent, week_spec, share_s, *rest = args
    w0, w1 = _parse_week_range(week_spec)
    share = float(share_s)
    rate = float(rest[0]) if rest else AGENT_RATE.get(agent)
    n = 0
    for c in calls:
        if c.agent != agent and w0 <= week_of(c.ts) <= w1 and rng.random() < share:
            c.agent = agent
            if rate is not None:
                c.answered = rng.random() < rate
            n += 1
    return calls, {"name": "funnel", "args": {"agent": agent, "weeks": [w0, w1], "share": share, "rate": rate}, "rows_affected": n}


def _noise_key(call: Call, by: str) -> str:
    return call.queue if by == "queue" else AGENTS[call.agent] if by == "team" else ""


def plant_noisy_volume(calls, args, rng):
    """noisy_volume:sd[:queue|team] -- each week's volume moves by a random factor (a normal with this sd): week-to-week noise beyond
    counting noise. With `queue` or `team`, each of those moves on its own, so children differ from each other as well as from last week."""
    sd = float(args[0])
    by = args[1] if len(args) > 1 else ""
    keys = sorted({(week_of(c.ts), _noise_key(c, by)) for c in calls})
    factor = {k: max(0.5, rng.gauss(1.0, sd)) for k in keys}
    kept: list[Call] = []
    extra: list[Call] = []
    for c in calls:
        f = factor[(week_of(c.ts), _noise_key(c, by))]
        if f < 1.0 and rng.random() > f:
            continue
        kept.append(c)
        if f > 1.0 and rng.random() < f - 1.0:
            extra.append(Call(f"{c.call_id}N", c.ts + timedelta(seconds=rng.randrange(1, 600)), c.agent, c.queue, c.reason, c.answered, c.handle))
    return kept + extra, {"name": "noisy_volume", "args": {"sd": sd, "by": by or "all", "factors": {f"{w}/{k}" if k else str(w): round(f, 3) for (w, k), f in factor.items()}}, "rows_affected": len(extra)}


def plant_noisy_rate(calls, args, rng):
    """noisy_rate:sd[:queue|team] -- each week's service level moves by a random amount (a normal with this sd, in points of service level)."""
    sd = float(args[0])
    by = args[1] if len(args) > 1 else ""
    keys = sorted({(week_of(c.ts), _noise_key(c, by)) for c in calls})
    shift = {k: rng.gauss(0.0, sd) for k in keys}
    n = 0
    for c in calls:
        d = shift[(week_of(c.ts), _noise_key(c, by))]
        if d < 0 and c.answered and rng.random() < -d / BASE_SERVICE_LEVEL:
            c.answered = False
            n += 1
        elif d > 0 and not c.answered and rng.random() < d / (1.0 - BASE_SERVICE_LEVEL):
            c.answered = True
            n += 1
    return calls, {"name": "noisy_rate", "args": {"sd": sd, "by": by or "all", "shifts": {f"{w}/{k}" if k else str(w): round(d, 4) for (w, k), d in shift.items()}}, "rows_affected": n}


def plant_degrade(calls, args, rng):
    """degrade:wkN:share -- each call answered in time becomes late with probability `share`: the service level falls everywhere alike."""
    week_spec, share_s = args
    w0, w1 = _parse_week_range(week_spec)
    share = float(share_s)
    n = 0
    for c in calls:
        if w0 <= week_of(c.ts) <= w1 and c.answered and rng.random() < share:
            c.answered = False
            n += 1
    return calls, {"name": "degrade", "args": {"weeks": [w0, w1], "share": share}, "rows_affected": n}


def plant_ramp_down(calls, args, rng):
    """ramp_down:wkN:keep -- the newest weeks hold only `keep` of their calls: the data was still arriving when it was copied."""
    week_spec, keep_s = args
    w0, w1 = _parse_week_range(week_spec)
    keep = float(keep_s)
    kept, dropped = [], 0
    for c in calls:
        if w0 <= week_of(c.ts) <= w1 and rng.random() > keep:
            dropped += 1
            continue
        kept.append(c)
    return kept, {"name": "ramp_down", "args": {"weeks": [w0, w1], "keep": keep}, "rows_affected": dropped}


FAULTS: dict[str, Plant] = {
    "understaffed": plant_understaffed,
    "missing_logs": plant_missing_logs,
    "offset": plant_offset,
    "block_outage": plant_block_outage,
    "slow_queue": plant_slow_queue,
    "improve": plant_improve,
    "reroute": plant_reroute,
    "long_calls": plant_long_calls,
    "surge": plant_surge,
    "surge_block": plant_surge_block,
    "surge_all": plant_surge_all,
    "star_agent": plant_star_agent,
    "bad_week": plant_bad_week,
    "funnel": plant_funnel,
    "noisy_volume": plant_noisy_volume,
    "noisy_rate": plant_noisy_rate,
    "degrade": plant_degrade,
    "ramp_down": plant_ramp_down,
}


def apply_fault(calls: list[Call], raw: str, rng: random.Random) -> tuple[list[Call], dict]:
    name, *args = raw.split(":")
    if name not in FAULTS:
        raise ValueError(f"unknown fault {name!r}; known faults: {sorted(FAULTS)}")
    calls, record = FAULTS[name](calls, args, rng)
    record["fault"] = raw
    return calls, record


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-seasonality", action="store_true", help="flat rates: no hour, weekday, peak or holiday effects (arrival volumes stay seasonal, as before)")
    parser.add_argument("--weeks", type=int, default=10)
    parser.add_argument("--calls", type=int, default=120000)
    parser.add_argument("--fault", action="append", default=[], metavar="NAME:ARG:...", help="repeatable")
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).parent / "raw")
    args = parser.parse_args()

    global SEASONAL
    SEASONAL = not args.no_seasonality
    rng = random.Random(args.seed)
    calls = generate_base(rng, args.calls, args.weeks)

    QUEUE_EXTRA_MISS.clear()
    AGENT_RATE.clear()
    records = []
    for raw in args.fault:
        calls, record = apply_fault(calls, raw, rng)
        records.append(record)

    calls.sort(key=lambda c: (c.ts, c.call_id))
    out: Path = args.out_dir
    write_csv(out / "calls.csv", [c.to_row() for c in calls], ["call_id", "ts", "agent", "queue", "call_reason", "answered_within_20s", "handle_seconds", "is_holiday", "is_peak"])
    write_csv(
        out / "agents.csv",
        [{"agent": a, "team": t, "site": TEAMS[t], "centre": SITES[TEAMS[t]]} for a, t in AGENTS.items()],
        ["agent", "team", "site", "centre"],
    )
    (out / "faults.json").write_text(
        json.dumps({"seed": args.seed, "weeks": args.weeks, "calls_requested": args.calls, "calls_written": len(calls), "faults": records}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {len(calls)} calls -> {out}")
    for r in records:
        print(f"  planted {r['fault']}: {r['rows_affected']} rows affected")


if __name__ == "__main__":
    main()
