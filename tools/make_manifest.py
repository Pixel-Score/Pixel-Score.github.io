#!/usr/bin/env python3
"""Rebuild episodes/index.json from the decoded episode JSON under episodes/.

Layout:   episodes/<GAME>/<Season>/<episode>.json      e.g. episodes/SHS/Season 1/1_Making_Some_Dough.json
          (GAME is SHS or COD; any other folder name also works and becomes its own game)

Usage (from the site root):  python3 tools/make_manifest.py

Each entry records the path, the episode title from the JSON ("episode", else "title", else the file
name) and, when the decoder wrote them, pack_id / episode_id. The page groups entries by game and
season from the path and sorts episodes by episode_id, else by the number the file name starts with.
Decode episodes with:  python3 shs_decoder.py Episode.exp --format json -o "episodes/SHS/Season 1/Episode.json"
"""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent / "episodes"
items = []
for p in sorted(root.rglob("*.json")):
    rel = p.relative_to(root).as_posix()
    if rel == "index.json":
        continue
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"skip {rel}: {e}")
        continue
    if not isinstance(d, dict) or not (isinstance(d.get("segments"), dict) or isinstance(d.get("scenes"), list)):
        print(f"skip {rel}: not decoder output")
        continue
    it = {"file": rel, "title": str(d.get("episode") or d.get("title") or p.stem)}
    for k in ("pack_id", "episode_id"):
        if d.get(k) is not None:
            it[k] = d[k]
    items.append(it)
(root / "index.json").write_text(json.dumps(items, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
games = sorted({i["file"].split("/")[0] for i in items if "/" in i["file"]})
print(f"wrote {len(items)} episode(s) to {root / 'index.json'}" + (f" (games: {', '.join(games)})" if games else ""))
