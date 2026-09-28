#!/usr/bin/env python3
"""
generate_program.py
────────────────────────────────────────────────────────────────────────────
Converts the source workbook ("Deadlift_210_220_Final.xlsx") into the
normalized program JSON used to seed Firestore (users/{uid}/programs/... and
.../days/...), applying every documented correction in import-mapping.json.

WHY THIS SCRIPT EXISTS (read this before touching it)
  The workbook mixes clean tables with human-formatted text, has rows whose
  labels are shifted by one position in several places, and encodes
  percentages three different ways across its sheets. Rather than guess
  silently, every non-literal decision (unit corrections, exercise merges,
  ambiguous prescriptions) is recorded in data/import-mapping.json and
  applied here by reference, so it stays auditable and editable.

SCOPE / HONESTY NOTE
  Day/section BOUNDARIES below (which rows belong to Day 1 vs Day 2, etc.)
  are pinned to this specific workbook's row layout, because the sheet's
  header rows are not reliably self-describing (see Phase 1 analysis:
  "row shift" bug). This is a one-time personal import, not a generic
  parser. A generic, UI-assisted importer for arbitrary future spreadsheets
  is planned for Phase 5.

  WITHIN each day block, exercise rows themselves ARE parsed generically
  from their actual cell content (name / sets×reps / intensity / notes),
  not retyped by hand — so the numbers below are computed from the sheet,
  not hardcoded from memory.

USAGE
    python3 generate_program.py \
        --source /path/to/Deadlift_210_220_Final.xlsx \
        --mapping ../data/import-mapping.json \
        --out ../data/program.deadlift-8wk.json
"""

import argparse
import json
import re
import sys
from pathlib import Path

from openpyxl import load_workbook


# ── helpers ──────────────────────────────────────────────────────────────

def round_to(value, increment):
    if increment == 0:
        return value
    return round(value / increment) * increment


def pct_of(base, pct):
    """pct given as e.g. 0.75 for 75%."""
    return base * pct


def parse_sets_reps(raw):
    """'5x3' / '4×8' / '3x12–15' / '3x60s' -> dict."""
    if raw is None:
        return {"sets": None, "reps": None, "raw": None}
    s = str(raw).replace("×", "x").strip()
    m = re.match(r"(\d+)\s*x\s*([\d\-–]+)(s)?", s, re.IGNORECASE)
    if not m:
        return {"sets": None, "reps": None, "raw": s}
    sets = int(m.group(1))
    rep_field = m.group(2).replace("–", "-")
    is_time = bool(m.group(3))
    if "-" in rep_field:
        lo, hi = rep_field.split("-")
        reps = {"min": int(lo), "max": int(hi)}
    else:
        reps = int(rep_field)
    return {
        "sets": sets,
        "reps": None if is_time else reps,
        "durationSec": int(rep_field.split("-")[0]) if is_time else None,
        "raw": s,
    }


def parse_intensity(raw, corrections_by_location, location_key):
    """
    Returns a `load` object per the schema:
      {type:'percent', percent:0.8}
      {type:'percentRange', min:0.7, max:0.75}
      {type:'fixed', kg: 40, perHand?: bool}
      {type:'none'}
    Falls back to a correction from import-mapping.json when the raw value
    is text/corrupted rather than a clean number or percent string.
    """
    if location_key in corrections_by_location:
        return corrections_by_location[location_key]["correctedValue"]

    if raw is None or (isinstance(raw, str) and raw.strip() == "-"):
        return {"type": "none"}

    if isinstance(raw, (int, float)):
        return {"type": "fixed", "kg": float(raw)}

    s = str(raw).strip().replace(",", ".").replace("%", "")
    m_range = re.match(r"^(\d+(?:\.\d+)?)\s*[\-–]\s*(\d+(?:\.\d+)?)\.?$", s)
    if m_range:
        return {
            "type": "percentRange",
            "min": float(m_range.group(1)) / 100,
            "max": float(m_range.group(2)) / 100,
        }
    m_single = re.match(r"^(\d+(?:\.\d+)?)\.?$", s)
    if m_single:
        return {"type": "percent", "percent": float(m_single.group(1)) / 100}

    # Unrecognized text (e.g. contained a Croatian note) -> flag, don't guess.
    return {"type": "none", "needsReview": True, "rawText": str(raw)}


def block_pct(base, absolute_str):
    """'185×1' or '4×5 @ 150' style strings -> {"weightKg", "percent"} vs base."""
    if absolute_str is None:
        return None
    s = str(absolute_str)
    m = re.search(r"@\s*(\d+(?:\.\d+)?)", s) or re.match(r"^(\d+(?:\.\d+)?)", s)
    if not m:
        return None
    kg = float(m.group(1))
    return {"weightKg": kg, "percentOfBase": round(kg / base, 4)}


# ── main ─────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--mapping", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    mapping = json.loads(Path(args.mapping).read_text())
    base_1rms = mapping["baseOneRepMaxes"]
    corrections_by_location = {c["location"]: c for c in mapping["corrections"]}
    alias_lookup = {}
    for canonical, aliases in mapping["exerciseAliases"].items():
        for a in aliases:
            alias_lookup[a.strip().lower()] = canonical

    def resolve_exercise_id(name):
        return alias_lookup.get(str(name).strip().lower(), None)

    wb = load_workbook(args.source, data_only=True)
    plan = wb["4-Week Strength Plan"]
    block = wb["DL_210_220_Block"]
    overview = wb["Full_progression_overview"]

    def rows(ws, min_row, max_row, max_col=6):
        return list(ws.iter_rows(min_row=min_row, max_row=max_row, max_col=max_col, values_only=True))

    # ── 1. Deadlift block (Day 1 main lift) — structural source of truth ──
    block_rows = rows(block, 2, 9, 5)     # weeks 1-8, top single/backoff/SGDL/notes
    warmup_rows = rows(block, 16, 23, 3)  # weeks 1-8 warm-up ramps

    deadlift_week_variants = []
    for i, r in enumerate(block_rows):
        week_num, top_single, backoff, sgdl, notes = r
        top = block_pct(base_1rms["deadlift"], top_single)
        back = parse_sets_reps(re.sub(r"@.*", "", str(backoff)).strip()) if backoff and "@" in str(backoff) else {"raw": backoff}
        back_load = block_pct(base_1rms["deadlift"], backoff) if backoff and "@" in str(backoff) else None
        sgdl_sets = parse_sets_reps(re.sub(r"@.*", "", str(sgdl)).strip()) if sgdl and "@" in str(sgdl) else None
        sgdl_load = block_pct(base_1rms["deadlift"], sgdl) if sgdl and "@" in str(sgdl) else None
        is_deload = "deload" in str(notes).lower()
        deadlift_week_variants.append({
            "week": int(week_num),
            "isDeload": is_deload,
            "isPrAttempt": "pr" in str(notes).lower(),
            "topSingle": {
                "sets": 1, "reps": 1,
                "load": {"type": "percent", "percent": top["percentOfBase"]} if top else {"type": "none"},
                "sourceWeightKgAtImport": top["weightKg"] if top else None,
            },
            "backoff": {
                "sets": back.get("sets"), "reps": back.get("reps"),
                "load": {"type": "percent", "percent": back_load["percentOfBase"]} if back_load else {"type": "none"},
                "note": None if back_load else str(backoff),
            },
            "sgdl": ({
                "sets": sgdl_sets.get("sets"), "reps": sgdl_sets.get("reps"),
                # exerciseId for this sub-entry is 'snatch-grip-deadlift' (set
                # further down where weekly variants are consumed), which has
                # no 1RM of its own — this is always derived from the
                # Deadlift training max, same as the Day 3 SGDL occurrence,
                # so the basis is marked explicitly rather than left to the
                # (wrong, for this case) default of "own exerciseId".
                "load": {"type": "percent", "percent": sgdl_load["percentOfBase"], "of": "deadlift"} if sgdl_load else {"type": "none"},
            } if sgdl_sets else {"sets": 0, "note": str(sgdl)}),
            "notes": str(notes) if notes else None,
            "warmupSets": [],
        })

    for i, r in enumerate(warmup_rows):
        week_num, _top, warmup_str = r
        sets_list = []
        for tok in str(warmup_str).split(","):
            tok = tok.strip()
            m = re.match(r"(\d+(?:\.\d+)?)\s*[x×]\s*(\d+)", tok)
            if m:
                sets_list.append({"kg": float(m.group(1)), "reps": int(m.group(2))})
        deadlift_week_variants[i]["warmupSets"] = sets_list

    # ── 2. Overview per-week % ranges for Squat / RDL / Bench (weeks 1-8) ──
    overview_rows = rows(overview, 9, 52, 6)
    overview_by_exercise_week = {}
    for r in overview_rows:
        if not r or r[0] is None or r[1] is None:
            continue
        ex_name, week, cycle, intensity, _weight_cached, focus = r
        canon = resolve_exercise_id(ex_name)
        if canon is None or canon == "overhead-press":
            continue
        loc_key = f"Full_progression_overview:{ex_name}:week{int(week)}"
        load = parse_intensity(intensity, corrections_by_location, loc_key)
        overview_by_exercise_week[(canon, int(week))] = {
            "cycle": cycle, "isDeload": "deload" in str(cycle).lower(),
            "focus": focus, "load": load,
        }

    # ── 3. Week metadata (cycle / phase / focus / isDeload) ──
    weeks_meta = []
    for w in range(1, 9):
        dl = next(v for v in deadlift_week_variants if v["week"] == w)
        ov = overview_by_exercise_week.get(("deadlift", w), {})
        weeks_meta.append({
            "week": w,
            "cycle": 1 if w <= 4 else 2,
            "isDeload": dl["isDeload"],
            "isPrAttempt": dl["isPrAttempt"],
            "focusFromOverview": ov.get("focus"),
            "deadliftNotesFromBlock": dl["notes"],
            "_note": "Block and Overview sheets disagree on weeks 3/4/7/8's character (see Phase 1 analysis). isDeload/isPrAttempt come from the Block sheet (deadlift structural source of truth); focusFromOverview is descriptive text only and may not match for those weeks.",
        })

    # ── 4. Day 1 accessories from the plan sheet (rows 11-15 / 56-59) ──
    def build_accessory(name_cell, sets_reps_cell, intensity_cell, notes_cell, loc_key, week_range):
        canon = resolve_exercise_id(name_cell) or re.sub(r"[^a-z0-9]+", "-", str(name_cell).lower()).strip("-")
        sr = parse_sets_reps(sets_reps_cell)
        load = parse_intensity(intensity_cell, corrections_by_location, loc_key)
        return {
            "exerciseId": canon,
            "displayName": name_cell,
            "sets": sr.get("sets"), "reps": sr.get("reps"), "durationSec": sr.get("durationSec"),
            "load": load,
            "notes": notes_cell,
            "weeks": week_range,
        }

    day1_accessories_c1 = [
        build_accessory("Leg Press (High Foot Placement)", "4x8", "65–75%", "aktivira kvadove uz manji stres na leđa i zglobove", "plan:day1:legpress:c1", [1, 2, 3, 4]),
        build_accessory("Romanian Deadlift", "3x8", "60–65%", "Hamstring hypertrophy", "plan:day1:rdl:c1", [1, 2, 3]),
        build_accessory("Hack squat", "4x6-10", "-", None, "plan:day1:hack:c1", [1, 2, 3, 4]),
        build_accessory("Core (Ab wheel / Leg raises)", "3x12-15", "-", "Core stability", "plan:day1:core:c1", [1, 2, 3, 4]),
    ]
    day1_accessories_c2 = [
        build_accessory("Leg Press (High Foot Placement)", "4x8", "70–80%", "Focus on power and depth", "plan:day1:legpress:c2", [5, 6, 7, 8]),
        build_accessory("Romanian Deadlift", "3x6-8", "65–70%", "Hamstring and glute strength", "plan:day1:rdl:c2", [5, 6, 7]),
        build_accessory("Hack squat", "4x6-10", "-", "Leg drive", "plan:day1:hack:c2", [5, 6, 7, 8]),
        build_accessory("Core (Ab wheel / Cable crunch)", "3x15", "-", "Core stability and tension", "plan:day1:core:c2", [5, 6, 7, 8]),
    ]
    # RDL week 4 & 8 use the overview's per-week deload % instead of the plan's flat range
    for wk, acc_list in ((4, day1_accessories_c1), (8, day1_accessories_c2)):
        ov = overview_by_exercise_week.get(("romanian-deadlift", wk))
        if ov:
            for a in acc_list:
                if a["exerciseId"] == "romanian-deadlift":
                    a["load"] = ov["load"]

    day2_items = [
        build_accessory("Landmine press", "3x8-12", "22 pocetak", "Shoulder strength", "Cycle 1 & 2, Day 2, Landmine Press, Intensity column ('22 pocetak')", list(range(1, 9))),
        build_accessory("Pull/Row (Neutral grip)", "4x8-10", "-", "Lateral stability, elbow-safe", "plan:day2:pullrow", [1, 2, 3, 4]),
        build_accessory("DB Row", "3x10", None, None, "Cycle 1, Day 2, DB Row", [1, 2, 3, 4]),
        build_accessory("Face pulls + Triceps dips", "3x12-15", "-", "Superset finisher (split into 2 logged exercises)", "plan:day2:facepull", [1, 2, 3, 4]),
        build_accessory("Rope Triceps Pushdown (Neutral Grip)", "3x12-15", "-", "Dlanovi paralelni, bez forsiranja lakta", "plan:day2:pushdown", [1, 2, 3, 4]),
        build_accessory("Overhead rope extension", "2x12", "-", None, "plan:day2:ropeext", [1, 2, 3, 4]),
        build_accessory("Wrist Extensor Stretch", "2x30s", "-", "Istezanje podlaktice nakon treninga", "plan:day2:wrist", [1, 2, 3, 4]),
    ]
    day2_items_c2 = [
        build_accessory("Neutral Grip Row", "4x8", "-", "Keep elbow-friendly pulling", "plan:day2:neutralrow:c2", [5, 6, 7, 8]),
        build_accessory("DB Row", "3x8-10", None, "Lat thickness", "Cycle 2, Day 2, DB Row", [5, 6, 7, 8]),
        build_accessory("Face Pulls + Pushdowns", "3x15", "-", "Stability and joint health", "plan:day2:facepull:c2", [5, 6, 7, 8]),
    ]

    day3_items = [
        build_accessory("Deficit / Snatch-grip Deadlift", "3x5", "65–75%", "DL accessory. Snatch-Grip Deadlift — user confirmed 2026-09-25 this source wording means SGDL, not a Deficit Deadlift (see import-mapping.json:deficit-sgdl-day3). % calculated against the standard Deadlift training 1RM (no separate SGDL max exists).", "plan:day3:deficit-sgdl:c1", [1, 2, 3]),
        build_accessory("Single leg legpress", "3x10", "-", "Single-leg balance", "plan:day3:singleleg", [1, 2, 3, 4]),
        build_accessory("Hamstring Curl", "3x12", "-", "Posterior chain hypertrophy", "plan:day3:hamcurl", [1, 2, 3, 4]),
        build_accessory("Core / Plank", "3x60s", "-", "Stability & bracing", "plan:day3:plank", [1, 2, 3, 4]),
    ]
    # Explicit calculation basis: SGDL has no 1RM of its own. This is a
    # program-design resolution (user confirmed 2026-09-25), not something
    # the spreadsheet itself proved — Phase 3 must resolve this percentRange
    # against the Deadlift training 1RM, not any SGDL-specific max.
    day3_items[0]["load"]["of"] = "deadlift"
    day3_items_c2 = [
        build_accessory("Deficit / Snatch Deadlift", "3x4", "70–80%", "Posterior chain overload. Snatch-Grip Deadlift — user confirmed 2026-09-25 this source wording means SGDL, not a Deficit Deadlift (see import-mapping.json:deficit-sgdl-day3). % calculated against the standard Deadlift training 1RM (no separate SGDL max exists).", "plan:day3:deficit-sgdl:c2", [5, 6, 7]),
        build_accessory("Bulgarian Split Squat", "3x8", "-", "Control & balance", "plan:day3:bulgarian", [5, 6, 7, 8]),
        build_accessory("Hamstring Curl", "3x10", "-", "Posterior chain isolation", "plan:day3:hamcurl:c2", [5, 6, 7, 8]),
        build_accessory("Core / Plank", "3x60s", "-", "Bracing work", "plan:day3:plank:c2", [5, 6, 7, 8]),
    ]
    day3_items_c2[0]["load"]["of"] = "deadlift"

    day4_items = [
        build_accessory("Pendlay Row", "4x6-8", "-", "Power pull", "plan:day4:pendlay:c1", [1, 2, 3, 4]),
        build_accessory("Landmine press", "3x10", "-", "Deltoid balance", "plan:day4:landmine:c1", [1, 2, 3, 4]),
        build_accessory("Chest-supported Row (Neutral Grip)", "4x10", "-", "Elbow-friendly lat work", "plan:day4:csrow:c1", [1, 2, 3, 4]),
        build_accessory("Straight-arm Pulldown (Cable/Band)", "3x15", "-", "Lat isolation", "plan:day4:pulldown:c1", [1, 2, 3, 4]),
        build_accessory("Rope Triceps Pushdown (Neutral Grip)", "4x12-15", "-", "Dlanovi paralelni, bez forsiranja lakta", "plan:day4:rope:c1", [1, 2, 3, 4]),
        build_accessory("Isometric Biceps Hold (Band)", "3x30s", "-", "Lagani izometrijski otpor", "plan:day4:isobiceps:c1", [1, 2, 3, 4]),
        build_accessory("Reverse Curl (Light Band/Dumbbell)", "2x15", "-", "Dlanovi prema dolje, lagano", "plan:day4:revcurl:c1", [1, 2, 3, 4]),
        build_accessory("Wrist Extensor Stretch", "3x30s", "-", "Istezanje podlaktice nakon treninga", "plan:day4:wrist:c1", [1, 2, 3, 4]),
    ]
    day4_items_c2 = [
        build_accessory("Pendlay Row", "4x6", None, "Explosive row", "Cycle 2, Day 4, Pendlay Row", [5, 6, 7, 8]),
        build_accessory("Landmine press", "3x8-10", "45804 (read back as a datetime: 2025-05-27)", "Overhead stability", "Cycle 2, Day 4, Landmine Press, Intensity column", [5, 6, 7, 8]),
        build_accessory("Chest-supported Row (Neutral Grip)", "4x8-10", None, "Elbow-friendly pull", "Cycle 2, Day 4, Chest-Supported Row", [5, 6, 7, 8]),
        build_accessory("Straight-arm Pulldown (Cable/Band)", "3x12", "-", "Lat activation", "plan:day4:pulldown:c2", [5, 6, 7, 8]),
    ]

    # ── 5. Assemble main lifts for Day 2 (Bench) & Day 3 (Squat) from overview
    def main_lift_weeks(canon):
        out = []
        for w in range(1, 9):
            ov = overview_by_exercise_week.get((canon, w))
            out.append({"week": w, "load": ov["load"] if ov else {"type": "none"}})
        return out

    bench_weeks = main_lift_weeks("bench-press")
    squat_weeks = main_lift_weeks("back-squat")

    # ── 6. Exercise library ──
    exercise_cues = {}
    for sheet_name in ("Elbow Health Notes", "Warm-Up & Mobility Notes"):
        ws = wb[sheet_name]
        for r in ws.iter_rows(min_row=2, values_only=True):
            if r and r[0]:
                canon = resolve_exercise_id(r[0]) or re.sub(r"[^a-z0-9]+", "-", str(r[0]).lower()).strip("-")
                exercise_cues[canon] = str(r[1]) if len(r) > 1 and r[1] else None

    exercise_library = []
    seen = set()
    all_names = set(alias_lookup.values())
    for canon in sorted(all_names):
        if canon in mapping["excludedExercises"]:
            continue
        if canon in seen:
            continue
        seen.add(canon)
        exercise_library.append({
            "id": canon,
            "name": canon.replace("-", " ").title(),
            "aliases": mapping["exerciseAliases"].get(canon, []),
            "cue": exercise_cues.get(canon),
        })

    # ── 7. Final program document ──
    program = {
        "schemaVersion": mapping["schemaVersion"],
        "id": "deadlift-focused-8wk",
        "name": "Deadlift Focused (8-Week Block)",
        "sourceFile": mapping["sourceFile"],
        "generatedBy": "scripts/generate_program.py",
        "roundingRules": {"barbell": 2.5, "dumbbell": 1, "machine": 2.5, "bodyweight": 0},
        "currentOneRepMaxesAtImport": {
            k: v for k, v in base_1rms.items()
            if k not in mapping["excludedExercises"] and not k.startswith("_")
        },
        "weeks": weeks_meta,
        "days": [
            {
                "id": "day1-lower-a-deadlift", "order": 1, "name": "Lower A (Deadlift Focus)",
                "sections": {
                    "warmup": {"source": "spreadsheet", "text": "2–3 min lagano hodanje/bicikl, Cat-Camel 2×8, Glute Bridge 2×15, Hip Opener 30s/str, RDL sa štapom 2×10"},
                    "main": [{
                        "exerciseId": "deadlift", "displayName": "Deadlift",
                        "structure": "block-driven", "weeklyVariants": deadlift_week_variants,
                    }],
                    "accessory": day1_accessories_c1 + day1_accessories_c2,
                    "cooldown": {"source": "spreadsheet", "text": "Hamstring, Piriformis, Hip Flexor, Back Hang – 30s svaki"},
                },
            },
            {
                "id": "day2-upper-a-bench", "order": 2, "name": "Upper A (Bench Focus)",
                "sections": {
                    "warmup": {"source": "spreadsheet", "text": "Band Pull-Apart 2×15, External Rotation 2×15, Arm Circles 2×10, Push-up Plus 2×10"},
                    "main": [{
                        "exerciseId": "bench-press", "displayName": "Bench Press",
                        "structure": "week-percent-range", "weeklyVariants": bench_weeks,
                        "setsReps": {1: "4x5", 2: "4x5", 3: "4x5", 4: "4x5", 5: "4x4", 6: "4x4", 7: "4x4", 8: "4x4"},
                    }],
                    "accessory": day2_items + day2_items_c2,
                    "cooldown": {"source": "spreadsheet", "text": "Chest, Shoulder, Triceps Stretch – 30s svaki"},
                },
            },
            {
                "id": "day3-lower-b-squat", "order": 3, "name": "Lower B (Squat + Posterior Chain)",
                "sections": {
                    "warmup": {"source": "spreadsheet", "text": "Leg Swings 2×10, Air Squats 2×10, Hip Band Walks 2×10, Ankle Rock 2×10; Quad, Glute, Hamstring, Calf Stretch – 30s svaki"},
                    "main": [{
                        "exerciseId": "back-squat", "displayName": "Back Squat",
                        "structure": "week-percent-range", "weeklyVariants": squat_weeks,
                        "setsReps": {1: "4x6-8", 2: "4x6-8", 3: "4x6-8", 4: "4x6-8", 5: "4x5", 6: "4x5", 7: "4x5", 8: "4x5"},
                    }],
                    "accessory": day3_items + day3_items_c2,
                    "cooldown": {"source": "spreadsheet", "text": None},
                },
            },
            {
                "id": "day4-upper-b-pull", "order": 4, "name": "Upper B (Pull Focus)",
                "sections": {
                    "warmup": {"source": "spreadsheet", "text": "Band Rows 2×15, Scapular Pull-Up 2×10, Shoulder Dislocates 2×10, Wrist Circles 2×10; Lat, Wrist, Trap Stretch + Neck Rolls – ukupno 2 min"},
                    "main": [
                        build_accessory("Incline Bench Press", "3x8", "-", "Upper chest", "plan:day4:inclinebench:c1", [1, 2, 3, 4]),
                        build_accessory("Incline Bench Press", "3x6-8", "db 40", "Slightly heavier. Day assignment confirmed by user 2026-09-25 — see import-mapping.json:incline-bench-day-assignment.", "Cycle 2, Incline Bench Press row (row 75), Intensity column ('db 40')", [5, 6, 7, 8]),
                    ],
                    "accessory": day4_items + day4_items_c2,
                    "cooldown": {"source": "spreadsheet", "text": None},
                },
            },
        ],
    }

    review_flags = []
    for day in program["days"]:
        scan_items = day["sections"]["accessory"] + [
            it for it in day["sections"]["main"] if isinstance(it, dict) and "exerciseId" in it and "structure" not in it
        ]
        for item in scan_items:
            if item.get("needsReview"):
                review_flags.append({"day": day["id"], "exercise": item["displayName"]})
            if isinstance(item.get("load"), dict) and item["load"].get("needsReview"):
                review_flags.append({"day": day["id"], "exercise": item["displayName"], "rawText": item["load"].get("rawText")})
    program["importReviewFlags"] = review_flags
    program["exerciseLibrary"] = exercise_library

    Path(args.out).write_text(json.dumps(program, indent=2, ensure_ascii=False))
    print(f"Wrote {args.out}")
    print(f"Exercises in library: {len(exercise_library)}")
    print(f"Review flags: {len(review_flags)}")
    for f in review_flags:
        print("  -", f)


if __name__ == "__main__":
    sys.exit(main())
