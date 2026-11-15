#!/usr/bin/env python3
"""Synthetic parcel-delivery data for the deliveries pack: a small, noisy dataset with one planted cause that is a combination.

Stdlib only. Writes to <out-dir> (default ./raw): orders.csv and faults.json.

  orders.csv   order_id, shipped_at, warehouse, carrier, region, delivered_on_time, delivery_hours, order_value

Twelve weeks from Monday 1 June 2026, 8,000 orders a week. Four warehouses with base on-time rates 0.92, 0.90, 0.88 and 0.91; three
carriers with offsets 0, -0.02 and +0.01; five regions. Every warehouse's rate moves each week by a random amount of its own (a normal
with sd 0.012), the way real operations do, so a quiet week is not a flat one.

The planted fault (unless --no-fault): in week 10 (3 to 9 August 2026, label 2026-W31) ONE carrier at ONE warehouse loses 0.30. Neither
that warehouse nor that carrier is bad elsewhere: the cause is the combination. faults.json records exactly what was planted.
"""
import argparse
import csv
import json
import random
from datetime import datetime, timedelta
from pathlib import Path

START = datetime(2026, 6, 1)
WAREHOUSES = {"wh_north": 0.92, "wh_south": 0.90, "wh_east": 0.88, "wh_west": 0.91}
CARRIERS = {"carrier_a": 0.0, "carrier_b": -0.02, "carrier_c": 0.01}
REGIONS = ["region_1", "region_2", "region_3", "region_4", "region_5"]
WOBBLE_SD = 0.012


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--weeks", type=int, default=12)
    parser.add_argument("--orders", type=int, default=8000, help="orders a week")
    parser.add_argument("--no-fault", action="store_true", help="plant nothing")
    parser.add_argument("--fault-week", type=int, default=10)
    parser.add_argument("--fault-warehouse", default="wh_east")
    parser.add_argument("--fault-carrier", default="carrier_b")
    parser.add_argument("--fault-drop", type=float, default=0.30)
    parser.add_argument("--out-dir", default="raw")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    wobble = {(w, wh): rng.gauss(0, WOBBLE_SD) for w in range(1, args.weeks + 1) for wh in WAREHOUSES}
    rows = []
    affected = 0
    n = 0
    for week in range(1, args.weeks + 1):
        for _ in range(args.orders):
            n += 1
            ts = START + timedelta(weeks=week - 1, days=rng.randrange(7), hours=rng.randrange(6, 20), minutes=rng.randrange(60))
            wh = rng.choice(list(WAREHOUSES))
            carrier = rng.choice(list(CARRIERS))
            p = WAREHOUSES[wh] + CARRIERS[carrier] + wobble[(week, wh)]
            if not args.no_fault and week == args.fault_week and wh == args.fault_warehouse and carrier == args.fault_carrier:
                p -= args.fault_drop
                affected += 1
            on_time = 1 if rng.random() < max(0.0, min(1.0, p)) else 0
            hours = round(max(4.0, rng.gauss(30 if on_time else 62, 8)), 1)
            rows.append({
                "order_id": f"o{n:07d}",
                "shipped_at": ts.strftime("%Y-%m-%d %H:%M:%S"),
                "warehouse": wh,
                "carrier": carrier,
                "region": rng.choice(REGIONS),
                "delivered_on_time": on_time,
                "delivery_hours": hours,
                "order_value": round(rng.lognormvariate(3.6, 0.5), 2),
            })
    rows.sort(key=lambda r: r["shipped_at"])

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "orders.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    fault_start = START + timedelta(weeks=args.fault_week - 1)
    faults = [] if args.no_fault else [{
        "name": "combination",
        "args": {"week": args.fault_week, "from": fault_start.strftime("%Y-%m-%d"), "to": (fault_start + timedelta(days=6)).strftime("%Y-%m-%d"),
                 "warehouse": args.fault_warehouse, "carrier": args.fault_carrier, "drop": args.fault_drop},
        "rows_affected": affected,
    }]
    with open(out / "faults.json", "w", encoding="utf-8") as f:
        json.dump({"seed": args.seed, "weeks": args.weeks, "wobble_sd": WOBBLE_SD, "faults": faults}, f, indent=2)


if __name__ == "__main__":
    main()
