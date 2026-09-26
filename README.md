# SHS Story Map

A static viewer for episode JSON produced by `shs_decoder.py --format json`. Every segment is a card
(speaker, expression and line for each node) connected by typed links: continuation, choice options
(with `when` conditions and effects), timed-out choices, variable checks (`==`, `!=`, `>`, `>=`, `<`,
`<=`), dispatch cases, random picks, minigame win / lose, checkpoint replays, jumps to other scenes
(with the section register value) and calls into routines. No build step; it runs as-is on GitHub Pages.

## Publish on GitHub Pages
1. Copy this folder into a repo (root or `/docs`).
2. Decode episodes into `episodes/<GAME>/<Season>/`, e.g.
   `python3 shs_decoder.py Ep.exp --format json -o "episodes/SHS/Season 1/1_Making_Some_Dough.json"`
   (`GAME` is `SHS` or `COD`; any other folder name becomes its own game).
3. Run `python3 tools/make_manifest.py` to rebuild `episodes/index.json`, then commit.
4. Repo Settings, Pages: deploy from the branch and folder you used.

## Episode picker
```
episodes/
  index.json            written by tools/make_manifest.py
  SHS/Season 1/1_Making_Some_Dough.json
  SHS/Season 2/...
  COD/Season 1/...
```
The **Game** picker (Surviving High School / Cause of Death) appears when more than one game has
episodes, and remembers your last choice. The episode list is grouped by season (natural order, so
Season 10 follows Season 9) and sorted by the decoder's `episode_id`, else the number the file name
starts with. Titles come from the JSON's `episode` field, else the file name.

If `index.json` is missing or empty and the site is served from `*.github.io`, the page lists the
repo's `episodes/` folder through the public GitHub API instead (public repos only, 60 requests an
hour per visitor), so the manifest step is optional there but still recommended.

Opening `index.html` straight from disk works too, but browsers block `fetch` on `file://`, so the
picker stays empty; use **Open JSON** or drag a file onto the page (or run `python3 -m http.server`).

## Views
- **Scene map**: one card per scene and per lowered routine, with jumps and calls between them.
- **Scene flow**: every segment of one scene or routine. Links that leave it end in a dashed portal
  card; click it to follow.
- **Everything**: the whole episode in one layout. Untick **Routines** to hide exact-code routines.

Side panel: scene and routine list; **Variables** (every set, change, check and read, with the
starting value from `variable_defaults`, plus `$Token` name placeholders from `name_vars`); full-text
**Search** (including text inside routine code). Click a card for the inspector: the full script with
bytecode offsets and image ids, outgoing and incoming links, and the raw JSON.

## What it understands
- **Story graph**: `entry`, `scene_entries`, `segments{ id: { nodes } }`, where the last node is the
  control node (`next`, `choice`, `gate`, `goto_scene`, `minigame`, `dispatch`, `random`,
  `checkpoint_replay`, `call` + `return`, `end`). Also `section_dispatch.entry_by_value` (badged as
  section entries), `scene_setup` (cast shown on scene cards), `format` / `value_from` on HUD lines,
  `var_set.expr`, `score_tier`, `set_string` / `string_default`.
- **Lowered routines** (`LOWERED_IR_CONTRACT.md`): `routines`, `ir_scenes`, and IR segments
  (`let`, `yield`, `if`, `next`, `call`, `ret`, `end`, `pause`). Routines are grouped by name, drawn with
  a blue-green edge, and IR expressions are printed readably (`L0 = arg1`, `var 2000 * 5`, table
  lookups). Dialogue and narration yields show as lines when their text is a constant.
- **Older scene-list output** (`scenes[...]`, overlay carving): links the file does not state
  explicitly are drawn dotted and marked inferred.

Any other field whose value names a segment is still drawn as a grey "other reference" link, so new
decoder fields show up without viewer changes. The viewer never adds routing of its own.

`examples/` holds test files: `encoded_test.json` is real decoder output for a small episode compiled
by `shs_encoder.py`; `contract_fixture.json` exercises every node kind in the contract (synthetic);
`legacy_fixture.json` covers the older format. Layout uses [dagre](https://github.com/dagrejs/dagre)
(MIT), vendored in `vendor/`.
