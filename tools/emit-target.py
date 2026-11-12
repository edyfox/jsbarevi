#!/usr/bin/env python3
"""Emit the frozen command surface as JSON, straight from the matrix generator.

Single source of truth: build_matrix.py's FAMILIES and target(). Writes
tools/target-surface.json so the behavioural audit does not restate the list.
"""
import importlib.util, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("bm", HERE / "build_matrix.py")
bm = importlib.util.module_from_spec(spec)
sys.argv = ["build_matrix.py"]
spec.loader.exec_module(bm)
bb, _ = bm.busybox_table()
bm.bb_active = set(bb)

rows = []
for family, keys in bm.FAMILIES:
    for key in keys:
        target = bm.target(key)
        if target == "out" or "drop" in target or "ruling" in target:
            continue
        rows.append({"family": family, "key": bm.render(key), "raw": key, "target": target})

Path(HERE / "target-surface.json").write_text(json.dumps(rows, indent=1) + "\n")
print(f"{len(rows)} in-scope commands -> tools/target-surface.json")
