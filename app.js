/* SHS Story Map — node/connection viewer for shs_decoder.py episode JSON.
 *
 * Accepts two shapes:
 *   1. Segment graph (current decoder, `--format json`): { entry, scene_entries, segments: { id: { nodes } },
 *      routines?, ir_scenes?, section_dispatch?, scene_setup?, variable_defaults?, name_vars? }.
 *      Each segment is a linear run of nodes whose last node is a control node (next / choice / gate /
 *      goto_scene / minigame / dispatch / random / checkpoint_replay / call+return / end). Lowered routines
 *      (see LOWERED_IR_CONTRACT.md) are segments of IR nodes (let / yield / if / next / call / ret / end).
 *   2. Scene list (older decoder / overlay output): { scenes: [ { scene, script, nodes, gate? } ] }.
 * Nothing here invents routing: every solid edge comes from a field in the JSON. Edges derived from the
 * older shape's structure are flagged "inferred" and drawn dotted.
 */
'use strict';

// ------------------------------------------------------------------ helpers
const $ = (s, r = document) => r.querySelector(s);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const str = v => (v == null ? '' : String(v));
const segKey = v => str(v).replace(/\.json$/i, '');
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string' && v !== '';
const numSort = (a, b) => {
  const na = parseFloat(a), nb = parseFloat(b);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  return str(a).localeCompare(str(b), undefined, { numeric: true });
};
const OPSYM = { eq: '==', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const opSym = o => OPSYM[o] || o || '==';

const KINDS = {
  next:    { label: 'Continues',            color: '--k-next' },
  option:  { label: 'Choice option',        color: '--k-option' },
  after:   { label: 'Choice merge point',   color: '--k-option', dash: '6 5' },
  timeout: { label: 'Choice timed out',     color: '--k-lose', dash: '6 5' },
  then:    { label: 'Condition true',       color: '--k-gate' },
  else:    { label: 'Condition false',      color: '--k-gate', dash: '6 5' },
  case:    { label: 'Dispatch case',        color: '--k-gate' },
  random:  { label: 'Random pick',          color: '--k-gate', dash: '2 4' },
  win:     { label: 'Minigame win',         color: '--k-win' },
  lose:    { label: 'Minigame lose',        color: '--k-lose' },
  mgafter: { label: 'After minigame',       color: '--k-next', dash: '6 5' },
  replay:  { label: 'Checkpoint replay',    color: '--k-lose', dash: '2 4' },
  fight:   { label: 'Fight',                color: '--k-lose', dash: '2 4' },
  goto:    { label: 'Go to scene',          color: '--k-goto', dash: '9 5' },
  call:    { label: 'Calls (and returns)',  color: '--k-call', dash: '4 3' },
  other:   { label: 'Other reference',      color: '--k-other', dash: '2 4' },
};
const INFERRED_DASH = '1.5 4';

const CUE_TYPES = new Set(['background', 'music', 'sfx', 'vibrate', 'wobble', 'loading', 'set_ui_default',
  'set_scene_value', 'native_noop', 'dialogue_notice', 'scene_badge', 'stop_music', 'control', 'pov_change',
  'set_expression', 'string_default', 'set_string']);
const CUE_YIELDS = new Set([5, 11, 16, 34, 35, 49, 64, 72, 73, 74, 75, 79, 80, 81, 82, 86, 88, 89, 90, 91]);
const VAR_SET_TYPES = /^(var_set|set_number|set_var|set_number_bit|var_random|random_below)$/;
const VAR_ADD_TYPES = /^(var_add|add_number|add_var|var_sub)$/;
const LINE_TYPES = new Set(['dialogue', 'narration', 'status', 'title_card', 'end_card', 'notification']);

// ------------------------------------------------------------------ expressions (story graph + IR)
function fmtExpr(e, ctx, top = true) {
  if (e == null) return '?';
  if (typeof e === 'number' || typeof e === 'boolean') return String(e);
  if (typeof e === 'string') return e;
  if (Array.isArray(e)) return '[' + e.map(x => fmtExpr(x, ctx, true)).join(', ') + ']';
  if (!isObj(e)) return String(e);
  if ('text' in e) return '"' + trunc(str(e.text), 60) + '"';
  if ('var' in e) return 'var ' + e.var;
  if ('local' in e) return localName(e.local, ctx);
  if ('addr' in e) return '&' + localName(e.addr, ctx);
  if ('reg' in e) return 'reg ' + e.reg;
  if ('scratch' in e) return 'scratch' + fmtExpr(e.scratch, ctx, false);
  if ('scratch_addr' in e) return '&scratch' + fmtExpr(e.scratch_addr, ctx, false);
  if ('table' in e) return 'table[' + (e.table || []).length + ']';
  if ('mem' in e) return 'mem[' + e.mem + ']';
  if ('dataval' in e) return String(e.dataval);
  if ('dataptr' in e) return '&data[' + e.dataptr + ']';
  if ('deref' in e) {
    const d = e.deref;
    if (isObj(d) && d.op === '+' && isObj(d.a) && 'table' in d.a) {
      const t = d.a.table || [];
      const shown = t.slice(0, 3).map(x => fmtExpr(x, ctx)).join(', ') + (t.length > 3 ? ', …' : '');
      return '[' + shown + '][' + fmtExpr(d.b, ctx) + ']';
    }
    return '*' + fmtExpr(d, ctx, false);
  }
  if ('op' in e) {
    if (e.op === 'neg') return '-' + fmtExpr(e.a, ctx, false);
    if (e.op === 'not') return 'not ' + fmtExpr(e.a, ctx, false);
    const s = fmtExpr(e.a, ctx, false) + ' ' + e.op + ' ' + fmtExpr(e.b, ctx, false);
    return top ? s : '(' + s + ')';
  }
  return JSON.stringify(e);
}
function localName(k, ctx) {
  const n = parseInt(k, 10);
  if (isNaN(n)) return 'L' + k;
  if (n < 0) {
    const p = ctx && ctx.params;
    if (p != null) { const i = p + 2 + n; if (i >= 0) return 'arg' + i; }
    return 'arg(' + n + ')';
  }
  return 'L' + n;
}
function exprVars(e, acc) {
  if (Array.isArray(e)) e.forEach(x => exprVars(x, acc));
  else if (isObj(e)) {
    if ('var' in e && !('op' in e) && Object.keys(e).length <= 3 && (typeof e.var !== 'object')) acc.add(str(e.var));
    for (const [k, v] of Object.entries(e)) if (k !== 'var' && (isObj(v) || Array.isArray(v))) exprVars(v, acc);
  }
  return acc;
}

// ------------------------------------------------------------------ conditions / effects
function fmtCond(g) {
  if (!g) return '';
  if (typeof g.cond === 'string') return g.cond;
  if (isObj(g.cond)) return fmtExpr(g.cond);
  if (typeof g.condition === 'string') return g.condition;
  const v = g.var ?? g.key ?? g.variable ?? g.name;
  const val = g.equals ?? g.value ?? g.threshold ?? g.gte ?? g.min;
  if (v != null && val != null) return `var ${v} ${opSym(g.op ?? g.cmp)} ${val}`;
  const parts = Object.entries(g).filter(([k, x]) => !['then', 'else', 'cases', 'next', 'offset', 'type', 'id', 'note'].includes(k) && !isObj(x) && !Array.isArray(x))
    .map(([k, x]) => `${k} ${x}`);
  return parts.join(', ');
}
function fmtWhen(w) {
  const list = Array.isArray(w) ? w : [w];
  return list.filter(isObj).map(c => `var ${c.var} ${opSym(c.op)} ${c.value ?? c.equals}`).join(' and ');
}
function fmtEffect(e) {
  const v = e.var ?? e.key ?? e.name ?? '?';
  if (e.type === 'var_random') return `var ${v} = random ${e.min ?? 0}…${e.max ?? '?'}`;
  if (e.type === 'random_below') return `var ${v} = random below ${e.max ?? e.bound ?? '?'}`;
  if (e.type === 'var_sub') return `var ${v} −= ${e.from_var != null ? 'var ' + e.from_var : e.value}`;
  if (e.expr != null) return `var ${v} = ${fmtExpr(e.expr)}`;
  if (e.type === 'var_add' || e.type === 'add_number') {
    const d = parseFloat(e.value ?? e.delta);
    if (!isNaN(d)) return `var ${v} ${d >= 0 ? '+' : '−'}= ${Math.abs(d)}`;
  }
  if (e.delta != null) { const d = parseFloat(e.delta); return `${v} ${d >= 0 ? '+' : '−'}${Math.abs(d)}`; }
  if (e.value != null) return `var ${v} = ${e.value}`;
  return String(v);
}

// ------------------------------------------------------------------ model
class Model {
  constructor(raw, name) {
    this.raw = raw; this.source = name;
    this.title = raw.episode || raw.title || name || 'Episode';
    this.cast = Array.isArray(raw.cast) ? raw.cast.filter(Boolean) : [];
    this.segs = new Map();      // id -> { id, scene, nodes, raw, badges[], routine? }
    this.scenes = new Map();    // group id -> { id, kind: scene|routine|loose, label, entry, segIds[], meta }
    this.edges = [];            // { from, to, kind, label, effects, inferred, cond }
    this.vars = new Map();      // name -> [{ seg, kind: set|add|check|read, text }]
    this.names = new Map();     // $Token -> info
    this.entry = null;
    this.notes = [];
    if (isObj(raw.segments)) { this.schema = 'segments'; this.fromSegments(raw); }
    else if (Array.isArray(raw.scenes)) { this.schema = 'scenes'; this.fromScenes(raw); }
    else throw new Error('This JSON has neither a "segments" map nor a "scenes" list, so it does not look like decoder output.');
    this.collectVars();
    this.indexEdges();
  }

  addEdge(from, to, kind, extra = {}) {
    if (to == null || to === '') return;
    this.edges.push({ from, to: str(to), kind, ...extra });
  }

  // ---- current decoder: segment graph
  fromSegments(raw) {
    const S = raw.segments;
    const routines = isObj(raw.routines) ? raw.routines : {};
    this.routines = routines;
    const rnames = Object.keys(routines).sort((a, b) => b.length - a.length);
    const routineOf = id => {
      for (const r of rnames) if (id === segKey(routines[r].entry) || id.startsWith(r + '_b')) return r;
      return null;
    };
    for (const [id, s] of Object.entries(S)) {
      const r = routineOf(id);
      this.segs.set(id, { id, scene: null, nodes: Array.isArray(s?.nodes) ? s.nodes : [], raw: s, badges: [],
        routine: r, ctx: r ? { params: parseInt(routines[r].params, 10) || 0 } : null });
    }
    const has = id => this.segs.has(segKey(id));
    const sceneEntries = isObj(raw.scene_entries) ? raw.scene_entries : {};
    const irScenes = new Set((raw.ir_scenes || []).map(str));

    for (const [id, seg] of this.segs) {
      const s = seg.raw || {};
      const used = new Set();
      const take = (to, kind, extra) => {
        if (typeof to === 'string' || typeof to === 'number') { used.add(segKey(to)); this.addEdge(id, segKey(to), kind, extra); }
      };
      const choice = c => {
        const timed = c.timed || parseInt(c.timer_ms ?? c.menu?.timeout_ms, 10) > 0;
        (c.options || []).forEach((o, i) => {
          if (!isObj(o)) return;
          const label = str(o.label ?? o.text ?? `Option ${o.index ?? i}`);
          const extra = { label, effects: o.effects, index: o.index ?? i };
          if (o.when) extra.guard = 'only if ' + fmtWhen(o.when);
          take(o.next ?? o.goto ?? o.target, 'option', extra);
          if (o.fight) take(o.fight, 'fight', { label });
        });
        if (c.after) take(c.after, 'after', { label: 'merge' });
        if (c.on_timeout) take(c.on_timeout, 'timeout', { label: timed ? `time up (${(parseInt(c.timer_ms ?? c.menu?.timeout_ms, 10) / 1000) || '?'}s)` : 'time up' });
      };
      const gate = g => {
        const cond = fmtCond(g);
        if (isStr(g.then)) take(g.then, 'then', { label: cond || 'true', cond });
        if (isStr(g.else)) take(g.else, 'else', { label: 'otherwise', cond });
        if (Array.isArray(g.cases)) g.cases.forEach(c => isObj(c) && take(c.next ?? c.then ?? c.target, 'case',
          { label: c.label ?? `${g.var ?? ''} == ${c.equals ?? c.value ?? '?'}`.trim(), cond }));
      };
      const minigame = m => {
        const thr = m.win_threshold != null ? ` (score ≥ ${m.win_threshold})` : '';
        if (isStr(m.win)) take(m.win, 'win', { label: 'win' + thr });
        if (isStr(m.lose)) take(m.lose, 'lose', { label: 'lose' });
        if (isStr(m.after)) take(m.after, 'mgafter', { label: 'after' });
      };
      const goto = g => {
        let t = null;
        if (typeof g === 'string') t = segKey(g);
        else if (isObj(g)) {
          for (const k of ['file', 'segment', 'entry', 'target', 'next']) if (isStr(g[k]) && has(g[k])) { t = segKey(g[k]); break; }
          if (!t) for (const k of ['to_scene', 'scene']) if (g[k] != null && sceneEntries[str(g[k])]) { t = segKey(sceneEntries[str(g[k])]); break; }
          if (!t && isStr(g.file)) t = segKey(g.file);
        }
        if (!t) return;
        const sr = isObj(g) && isObj(g.section_register) ? ` with var ${g.section_register.var} = ${g.section_register.value}` : '';
        take(t, 'goto', { label: 'go to ' + t + sr, sceneLabel: true, register: sr });
      };
      if (typeof s.next === 'string') take(s.next, 'next');
      if (isObj(s.gate)) gate(s.gate);
      if (isObj(s.choice)) choice(s.choice);
      if (isObj(s.minigame)) minigame(s.minigame);
      if (s.goto_scene) goto(s.goto_scene);

      for (const n of seg.nodes) {
        if (!isObj(n)) continue;
        switch (n.type) {
          case 'choice': case 'random_encounter': choice(n); break;
          case 'next': take(n.next, 'next'); break;
          case 'gate': gate(n); break;
          case 'goto_scene': goto(n); break;
          case 'minigame': minigame(n); break;
          case 'checkpoint_replay': take(n.next, 'replay', { label: 'replay from checkpoint' }); break;
          case 'dispatch':
            (n.arms || []).forEach(a => isObj(a) && take(a.scene ?? a.next, 'case', { label: `var ${n.state_var} == ${a.equals}` }));
            if (n.default != null) take(n.default, 'case', { label: 'otherwise' });
            break;
          case 'random':
            (n.options || []).forEach((o, i) => isObj(o) && take(o.scene ?? o.next, 'random', { label: `roll ${i}` }));
            if (n.exhausted != null) take(n.exhausted, 'random', { label: 'exhausted' });
            break;
          case 'if':
            take(n.then, 'then', { label: fmtExpr(n.cond, seg.ctx), cond: fmtExpr(n.cond, seg.ctx) });
            take(n.else, 'else', { label: 'otherwise' });
            break;
          case 'call':
            if (isStr(n.segment)) take(n.segment, 'call', { label: 'call' });
            else if (isStr(n.routine) && routines[n.routine]) {
              const args = (n.args || []).map(a => fmtExpr(a, seg.ctx)).join(', ');
              take(routines[n.routine].entry, 'call', { label: trunc(`${n.routine}(${args})`, 50) +
                (n.result_var != null ? ` → var ${n.result_var}` : '') });
            }
            break;
        }
        if (typeof n.next === 'string' && !['next', 'choice', 'checkpoint_replay', 'random_encounter'].includes(n.type)) take(n.next, 'next');
      }
      // Anything else in the segment that names another segment (new decoder fields show up without code changes)
      const scan = (obj, depth, keyPath) => {
        if (depth > 4 || obj == null) return;
        if (typeof obj === 'string') {
          const k = segKey(obj);
          if (k !== id && has(k) && !used.has(k)) { used.add(k); this.addEdge(id, k, 'other', { label: keyPath }); }
          return;
        }
        if (Array.isArray(obj)) { obj.forEach(x => scan(x, depth + 1, keyPath)); return; }
        if (isObj(obj)) for (const [k, v] of Object.entries(obj)) {
          if (['text', 'speaker', 'prompt', 'label', 'type', 'note', 'id', 'title', 'subtitle', 'name', 'rank', 'banner', 'pattern'].includes(k)) continue;
          scan(v, depth + 1, k);
        }
      };
      scan(s, 0, '');
      if (s.end || seg.nodes.some(n => isObj(n) && n.type === 'end')) seg.end = true;
    }

    // ---- groups: routines by name, scenes by the decoder's `s<N>` naming, BFS as fallback
    const addGroup = (id, g) => { if (!this.scenes.has(id)) this.scenes.set(id, { id, segIds: [], meta: {}, ...g }); return this.scenes.get(id); };
    const sceneKeys = Object.keys(sceneEntries).sort(numSort);
    for (const k of sceneKeys) {
      const setup = raw.scene_setup?.[k];
      addGroup(k, { kind: 'scene', label: `Scene ${k}` + (irScenes.has(k) ? ' (exact code)' : ''), entry: segKey(sceneEntries[k]),
        meta: { ir: irScenes.has(k), setup, dispatch: raw.section_dispatch?.[k] } });
    }
    for (const [r, info] of Object.entries(routines)) {
      addGroup('r:' + r, { kind: 'routine', label: `Routine ${r}`, entry: segKey(info.entry),
        meta: { params: info.params, offset: info.offset } });
    }
    const nameScene = id => { const m = /^s(\d+)(?:_|$)/.exec(id); return m ? m[1] : null; };
    for (const seg of this.segs.values()) {
      if (seg.routine) { seg.scene = 'r:' + seg.routine; continue; }
      const k = nameScene(seg.id);
      if (k != null && (this.scenes.has(k) || !sceneKeys.length)) {
        addGroup(k, { kind: 'scene', label: `Scene ${k}`, entry: null });
        seg.scene = k;
      }
    }
    // BFS from scene entries for anything the naming did not place (non-decoder names)
    const out = new Map();
    for (const e of this.edges) { if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e); }
    for (const k of sceneKeys) {
      const q = [segKey(sceneEntries[k])];
      while (q.length) {
        const id = q.shift(); const seg = this.segs.get(id);
        if (!seg || (seg.scene != null && id !== segKey(sceneEntries[k]))) continue;
        if (seg.scene == null) seg.scene = k;
        for (const e of out.get(id) || []) if (!['goto', 'call'].includes(e.kind)) { const t = this.segs.get(e.to); if (t && t.scene == null) q.push(e.to); }
      }
    }
    const loose = [...this.segs.values()].filter(s => s.scene == null);
    if (loose.length) {
      const k = this.scenes.size ? 'unplaced' : 'all';
      addGroup(k, { kind: 'loose', label: this.scenes.size ? 'Not reached from a scene start' : 'All segments', entry: loose[0].id });
      loose.forEach(s => (s.scene = k));
    }
    for (const g of this.scenes.values()) g.segIds = [];
    for (const seg of this.segs.values()) this.scenes.get(seg.scene).segIds.push(seg.id);
    for (const g of this.scenes.values()) {
      if (!g.entry || !this.segs.has(g.entry)) g.entry = g.segIds.find(i => nameScene(i) && i === 's' + g.id) || g.segIds[0];
    }

    // ---- badges
    for (const k of sceneKeys) { const es = this.segs.get(segKey(sceneEntries[k])); if (es) es.badges.push({ cls: 'entry', text: `Scene ${k} start` }); }
    for (const [r, info] of Object.entries(routines)) {
      const es = this.segs.get(segKey(info.entry));
      if (es) es.badges.push({ cls: 'routine', text: `Routine ${r}` + (parseInt(info.params, 10) ? `, ${info.params} args` : '') });
    }
    for (const [k, sd] of Object.entries(raw.section_dispatch || {})) {
      if (!isObj(sd)) continue;
      for (const [v, target] of Object.entries(sd.entry_by_value || {})) {
        const t = this.segs.get(segKey(target));
        if (t) t.badges.push({ cls: 'gate', text: `Enters here when var ${sd.register} = ${v}` });
      }
    }
    this.entry = raw.entry ? segKey(raw.entry) : (sceneKeys.length ? segKey(sceneEntries[sceneKeys[0]]) : null);
    const en = this.segs.get(this.entry); if (en) en.badges.unshift({ cls: 'entry', text: 'Episode start' });
    if (raw.note) this.notes.push(str(raw.note));
    if (irScenes.size) this.notes.push(`Scene ${[...irScenes].join(', ')} runs as exact code lifted from the bytecode: its entry calls a routine, shown as blue-green cards.`);

    // ---- name placeholders
    for (const [k, v] of Object.entries(raw.name_vars || {})) this.names.set(k, v);
  }

  // ---- older decoder: scenes -> nodes (with optional overlay splits)
  fromScenes(raw) {
    this.routines = {};
    this.notes.push('Older scene-list format. Nodes are in bytecode order, so links between a choice and the lines after it are inferred from layout (dotted) unless the file split them per option.');
    const scenes = raw.scenes;
    const byScript = new Map();
    scenes.forEach((sc, i) => { const k = str(sc.scene ?? i + 1); if (sc.script && !byScript.has(str(sc.script))) byScript.set(str(sc.script), k); });
    const pendingGotos = [];
    scenes.forEach((sc, i) => {
      const k = str(sc.scene ?? i + 1);
      const label = `Scene ${k}` + (sc.name ? ` (${sc.name})` : '');
      const scene = { id: k, kind: 'scene', label, entry: null, segIds: [], meta: { script: sc.script, protagonist: sc.protagonist,
        gate: sc.gate, source: sc.source, control_flow: sc.control_flow } };
      this.scenes.set(k, scene);
      const observed = sc.source === 'observed';
      let n = 0, cur = null, pending = [];
      const newSeg = suffix => {
        const id = `sc${k}${suffix}`;
        const seg = { id, scene: k, nodes: [], raw: null, badges: [] };
        this.segs.set(id, seg); scene.segIds.push(id); if (!scene.entry) scene.entry = id;
        return seg;
      };
      const ensure = () => {
        if (!cur) {
          cur = newSeg(n === 0 ? '' : `_${n}`); n++;
          for (const p of pending) this.addEdge(p.from, cur.id, p.kind, p.extra);
          pending = [];
        }
        return cur;
      };
      for (const node of sc.nodes || []) {
        if (!isObj(node)) continue;
        if (node.type === 'choice') {
          const seg = ensure(); seg.nodes.push(node);
          const opts = node.options || [];
          const bd = node.branch_dialogue;
          const perOption = Array.isArray(bd) && bd.length && bd.every(b => isObj(b) && Array.isArray(b.lines));
          if (perOption) {
            opts.forEach((o, oi) => {
              const br = bd.find(b => str(b.index) === str(o.index ?? oi));
              const extra = { label: str(o.label ?? `Option ${oi}`), effects: o.effects, inferred: !observed };
              if (br && br.lines.length) {
                const os = newSeg(`_${n}o${o.index ?? oi}`); n++;
                os.nodes = br.lines;
                this.addEdge(seg.id, os.id, 'option', extra);
                pending.push({ from: os.id, kind: 'next', extra: { inferred: true } });
              } else pending.push({ from: seg.id, kind: 'option', extra });
            });
          } else if (Array.isArray(node.outcomes) && node.outcomes.length) {
            node.outcomes.forEach((oc, oi) => {
              const os = newSeg(`_${n}r${oc.index ?? oi}`); n++;
              os.nodes = oc.lines || [];
              if (oc.ends_with_retry_prompt) os.badges.push({ cls: 'gate', text: 'Replay prompt' });
              this.addEdge(seg.id, os.id, 'option', { label: `outcome ${oc.index ?? oi}`, inferred: true });
              if (!oc.ends_with_retry_prompt) pending.push({ from: os.id, kind: 'next', extra: { inferred: true } });
            });
          } else if (Array.isArray(bd) && bd.length) {
            const os = newSeg(`_${n}all`); n++;
            os.nodes = bd;
            os.badges.push({ cls: 'gate', text: 'All options, unsplit' });
            this.addEdge(seg.id, os.id, 'option', { label: `any of ${opts.length} options`, inferred: true });
            pending.push({ from: os.id, kind: 'next', extra: { inferred: true } });
          } else {
            opts.forEach((o, oi) => pending.push({ from: seg.id, kind: 'option',
              extra: { label: str(o.label ?? `Option ${oi}`), effects: o.effects, inferred: true } }));
          }
          cur = null;
          continue;
        }
        if (node.type === 'goto_scene') {
          const seg = ensure(); seg.nodes.push(node);
          pendingGotos.push({ from: seg.id, to_scene: node.to_scene, script: node.script });
          cur = null; pending = [];
          continue;
        }
        ensure().nodes.push(node);
      }
      if (!scene.entry) ensure();
      const es = this.segs.get(scene.entry);
      es.badges.push({ cls: 'entry', text: `Scene ${k} start` });
      if (sc.gate) es.badges.push({ cls: 'gate', text: `Runs when ${fmtCond(sc.gate)}` });
      if (observed) es.badges.push({ cls: 'obs', text: 'Observed in play' });
    });
    for (const g of pendingGotos) {
      let k = g.to_scene != null ? str(g.to_scene) : null;
      if ((k == null || !this.scenes.has(k)) && g.script) k = byScript.get(str(g.script)) ?? k;
      const sc = k != null ? this.scenes.get(k) : null;
      if (sc) this.addEdge(g.from, sc.entry, 'goto', { label: `scene ${k}` });
    }
    const first = this.scenes.values().next().value;
    this.entry = first ? first.entry : null;
    const en = this.segs.get(this.entry); if (en) en.badges.unshift({ cls: 'entry', text: 'Episode start' });
  }

  collectVars() {
    const add = (name, rec) => {
      if (name == null || name === '') return;
      const k = str(name);
      if (!this.vars.has(k)) this.vars.set(k, []);
      const list = this.vars.get(k);
      if (!list.some(r => r.seg === rec.seg && r.kind === rec.kind && r.text === rec.text)) list.push(rec);
    };
    const isConst = v => typeof v === 'number' || (typeof v === 'string' && /^-?\d+$/.test(v));
    for (const seg of this.segs.values()) {
      const walk = nodes => nodes.forEach(n => {
        if (!isObj(n)) return;
        const t = n.type || '';
        const name = n.var ?? n.key;
        if (VAR_ADD_TYPES.test(t)) add(name, { seg: seg.id, kind: 'add', text: fmtEffect(n) });
        else if (VAR_SET_TYPES.test(t)) add(name, { seg: seg.id, kind: 'set', text: fmtEffect(n) });
        if (n.expr != null) exprVars(n.expr, new Set()).forEach(v => add(v, { seg: seg.id, kind: 'read', text: `used in ${fmtEffect(n)}` }));
        if (isObj(n.value_from)) add(n.value_from.var, { seg: seg.id, kind: 'read', text: `shown in "${trunc(str(n.text), 40)}"` });
        if (isObj(n.format)) exprVars(n.format.args, new Set()).forEach(v => add(v, { seg: seg.id, kind: 'read', text: `shown in "${trunc(str(n.format.pattern), 40)}"` }));
        if (t === 'gate' && name != null) add(name, { seg: seg.id, kind: 'check', text: fmtCond(n) });
        if (n.when) {
          const w = Array.isArray(n.when) ? n.when : [n.when];
          w.forEach(c => isObj(c) && add(c.var, { seg: seg.id, kind: 'check', text: `line shown only if ${fmtWhen(c)}` }));
        }
        if (t === 'choice') (n.options || []).forEach(o => isObj(o) && o.when && (Array.isArray(o.when) ? o.when : [o.when])
          .forEach(c => add(c.var, { seg: seg.id, kind: 'check', text: `option "${trunc(str(o.label), 30)}" only if ${fmtWhen(c)}` })));
        if (t === 'dispatch') add(n.state_var, { seg: seg.id, kind: 'check', text: `dispatch on ${(n.arms || []).length} values` });
        if (t === 'score_tier') add(n.var, { seg: seg.id, kind: 'check', text: 'end-of-episode rank' });
        if (t === 'goto_scene' && isObj(n.section_register)) add(n.section_register.var, { seg: seg.id, kind: 'set', text: `= ${n.section_register.value} before entering ${segKey(n.file)}` });
        if (t === 'call' && n.result_var != null) add(n.result_var, { seg: seg.id, kind: 'set', text: `= result of ${n.routine}` });
        if (t === 'if') exprVars(n.cond, new Set()).forEach(v => add(v, { seg: seg.id, kind: 'check', text: fmtExpr(n.cond, seg.ctx) }));
        if (t === 'yield') {
          const y = parseInt(n.yield, 10), a = n.args || [];
          if ((y === 44 || y === 54) && isConst(a[0])) add(a[0], { seg: seg.id, kind: 'set', text: `= ${fmtExpr(a[1], seg.ctx)} (code)` });
          if ((y === 45 || y === 55) && isConst(a[0])) add(a[0], { seg: seg.id, kind: 'read', text: `read into ${localName(n.to, seg.ctx)} (code)` });
          if ((y === 52 || y === 53) && isConst(a[1])) add(`${a[0]}:${a[1]}`, { seg: seg.id, kind: y === 52 ? 'set' : 'read', text: 'character-owned number (code)' });
        }
        if (Array.isArray(n.branch_dialogue)) n.branch_dialogue.forEach(b => Array.isArray(b?.lines) && walk(b.lines));
        if (Array.isArray(n.then)) walk(n.then);
      });
      walk(seg.nodes);
      const g = seg.raw && seg.raw.gate;
      if (isObj(g)) add(g.var ?? g.key ?? g.variable, { seg: seg.id, kind: 'check', text: fmtCond(g) });
    }
    for (const e of this.edges) {
      (e.effects || []).forEach(f => add(f.var ?? f.key ?? f.name,
        { seg: e.from, kind: f.delta != null ? 'add' : 'set', text: `${fmtEffect(f)} when "${e.label}" is picked` }));
    }
    for (const sc of this.scenes.values()) {
      const g = sc.meta.gate;
      if (isObj(g)) for (const [k, v] of Object.entries(g)) if (!isObj(v) && k !== 'once' && k !== 'event')
        add(k, { seg: sc.entry, kind: 'check', text: `scene ${sc.id} runs when ${fmtCond(g)}` });
      const sd = sc.meta.dispatch;
      if (isObj(sd) && sd.register != null) add(sd.register, { seg: sc.entry, kind: 'check', text: `scene ${sc.id} section register` });
    }
    const vd = this.raw.variable_defaults;
    this.varDefaults = isObj(vd) ? vd : null;
    if (this.varDefaults) for (const k of Object.keys(vd.values || {})) if (!this.vars.has(str(k))) this.vars.set(str(k), []);
  }

  indexEdges() {
    this.out = new Map(); this.inc = new Map();
    this.edges.forEach((e, i) => {
      e.i = i;
      if (!this.out.has(e.from)) this.out.set(e.from, []);
      if (!this.inc.has(e.to)) this.inc.set(e.to, []);
      this.out.get(e.from).push(e); this.inc.get(e.to).push(e);
    });
    this.missing = this.edges.filter(e => !this.segs.has(e.to));
    // name goto edges by their destination group
    for (const e of this.edges) if (e.sceneLabel) {
      const g = this.scenes.get(this.segs.get(e.to)?.scene);
      if (g) e.label = g.label + (e.register || '');
    }
  }

  lineCount(seg) {
    let n = 0;
    for (const x of seg.nodes) {
      if (!isObj(x)) continue;
      if (x.type === 'dialogue' || x.type === 'narration') n++;
      else if (x.type === 'yield' && [13, 15, 65].includes(parseInt(x.yield, 10))) n++;
    }
    return n;
  }
  sceneOf(segId) { const s = this.segs.get(segId); return s ? s.scene : null; }
  group(id) { return this.scenes.get(id); }
}

// ------------------------------------------------------------------ state
const state = {
  model: null, view: 'overview', scene: null, sel: null, showCues: false, cap: 8, showRoutines: true,
  k: 1, tx: 0, ty: 0, graph: null,
};
const stage = $('#stage'), world = $('#world'), svg = $('#edges');

// ------------------------------------------------------------------ node rendering
function speakerColor(name) {
  const m = state.model;
  let i = m ? m.cast.indexOf(name) : -1;
  if (i < 0) { i = 0; for (const c of str(name)) i = (i * 31 + c.charCodeAt(0)) >>> 0; }
  return `var(--spk${i % 6})`;
}
function textOf(a) { return isObj(a) && 'text' in a ? str(a.text) : null; }

function lineEl(speaker, text, opts = {}) {
  const d = el('div', 'ln' + (opts.thought ? ' thought' : ''));
  if (speaker) {
    const sp = el('span', 'spk', speaker); sp.style.color = speakerColor(speaker); d.append(sp);
  }
  if (opts.meta) d.append(el('span', 'emo', opts.meta + ' '));
  d.append(document.createTextNode(opts.thought ? `(${text})` : text));
  return d;
}

function formatLine(n) {
  if (isObj(n.format)) return `fills ${n.format.pattern.match(/%[cds]/g)?.length || 0} value(s): ${(n.format.args || []).map(a => fmtExpr(a)).join(', ')}`;
  if (isObj(n.value_from)) {
    const vf = n.value_from;
    let e = `var ${vf.var}`;
    if (vf.minus_from != null) e = `${vf.minus_from} − ${e}`;
    if (vf.multiply != null) e = `(${e}) × ${vf.multiply}`;
    return `%d = ${e}`;
  }
  return null;
}

function renderYield(n, ctx, full) {
  const y = parseInt(n.yield, 10), a = n.args || [];
  const to = n.to != null ? ` → ${localName(n.to, ctx)}` : '';
  if (y === 13 || y === 15 || y === 65) {
    let ti = y === 65 ? 1 : (y === 15 ? 1 : (typeof a[0] === 'number' && a[0] < 0 ? 1 : 0));
    const t = textOf(a[ti]);
    const speaker = y === 15 ? textOf(a[0]) : (y === 65 ? null : n.speaker);
    if (t != null) {
      if (y === 65) return el('div', 'ln narr', t);
      return lineEl(speaker || 'someone', t, { thought: a[0] === -2 });
    }
    const d = el('div', 'ln');
    if (speaker && y !== 65) { const sp = el('span', 'spk', speaker); sp.style.color = speakerColor(speaker); d.append(sp); }
    d.append(el('span', 'code', `${y === 65 ? 'narrate' : 'say'} ${fmtExpr(a[ti], ctx)}`));
    return d;
  }
  if (y === 1 && textOf(a[1]) != null) {
    const b = el('div', 'choice-box');
    b.append(el('div', 'box-label', `Choice (code): ${textOf(a[0]) || ''}${to}`));
    const ol = el('ol'); textOf(a[1]).split('|').forEach(o => ol.append(el('li', null, o))); b.append(ol);
    return b;
  }
  if (y === 8 && textOf(a[0]) != null) {
    const d = el('div', 'ln cardtitle', textOf(a[0])); if (textOf(a[1])) d.append(el('small', null, textOf(a[1]))); return d;
  }
  if ((y === 7 || y === 33) && textOf(a[0]) != null) {
    const d = el('div', 'ln cardtitle', textOf(a[0])); if (textOf(a[1])) d.append(el('small', null, textOf(a[1]))); return d;
  }
  if (y === 44) return codeLn(`set var ${fmtExpr(a[0], ctx)} = ${fmtExpr(a[1], ctx)}`);
  if (y === 45) return codeLn(`${localName(n.to, ctx)} = var ${fmtExpr(a[0], ctx)}`);
  if (y === 27) return codeLn(`${n.to != null ? localName(n.to, ctx) : 'r'} = random below ${fmtExpr(a[0], ctx)}`);
  if (y === 10) return codeLn(`schedule scene ${fmtExpr(a[0], ctx)}`);
  if (y === 0) return codeLn(`${n.to != null ? localName(n.to, ctx) : 'str'} = format(${a.map(x => fmtExpr(x, ctx)).join(', ')})`);
  const name = n.name || `yield_${y}`;
  const s = `${name}(${a.map(x => fmtExpr(x, ctx)).join(', ')})${to}`;
  return codeLn(full ? s : trunc(s, 90), CUE_YIELDS.has(y));
}
function codeLn(s, cue) { const d = el('div', 'ln' + (cue ? ' cue' : '')); d.append(el('span', 'code', s)); return d; }

function renderNode(n, full, ctx) {
  if (!isObj(n)) return el('div', 'ln cue', str(n));
  const t = n.type;
  let node;
  if (t === 'dialogue') {
    const meta = [n.emotion ? n.emotion : null, n.expression != null ? `expr ${n.expression}` : (n.emotion_code != null && n.emotion_code !== 'null' ? `expr ${n.emotion_code}` : null)]
      .filter(Boolean).join(', ');
    node = lineEl(str(n.speaker || '?'), str(n.text), { thought: str(n.mode) === '-2', meta: full ? meta : '' });
  } else if (t === 'narration') node = el('div', 'ln narr', str(n.text));
  else if (t === 'status' || t === 'notification') {
    node = el('div', 'ln status', str(n.text));
    const f = formatLine(n); if (f) node.append(el('span', 'fmt', f));
  } else if (t === 'title_card' || t === 'end_card') {
    node = el('div', 'ln cardtitle', str(n.title ?? n.text));
    if (n.subtitle) node.append(el('small', null, str(n.subtitle)));
  } else if (VAR_SET_TYPES.test(t || '') || VAR_ADD_TYPES.test(t || '')) {
    node = el('div', 'ln'); node.append(el('span', 'chip', fmtEffect(n)));
  } else if (t === 'gate') {
    node = el('div', 'ln'); node.append(el('span', 'chip check', `if ${fmtCond(n)}`));
    if (Array.isArray(n.then)) n.then.forEach(x => node.append(renderNode(x, full, ctx)));
  } else if (t === 'choice' || t === 'random_encounter') {
    node = el('div', 'choice-box');
    const timer = parseInt(n.timer_ms ?? n.menu?.timeout_ms, 10);
    node.append(el('div', 'box-label', (n.prompt ? `Choice: ${n.prompt}` : 'Choice') + (timer > 0 ? ` (timed, ${timer / 1000}s)` : '')));
    if (n.text) node.append(el('div', null, str(n.text)));
    const ol = el('ol');
    (n.options || []).forEach(o => {
      const li = el('li', null, str(isObj(o) ? (o.label ?? o.text ?? o.name) : o));
      if (isObj(o) && o.effects) li.append(el('span', 'emo', ` (${o.effects.map(fmtEffect).join(', ')})`));
      if (isObj(o) && o.when) li.append(el('span', 'emo', ` only if ${fmtWhen(o.when)}`));
      ol.append(li);
    });
    node.append(ol);
  } else if (t === 'minigame') {
    node = el('div', 'mg-box');
    const kind = n.minigame_type || n.kind || 'minigame';
    node.append(el('div', 'box-label', `Minigame: ${kind}` + (n.win_threshold != null ? `, win at ${n.win_threshold}` : '') +
      (n.timed ? `, ${(parseInt(n.timer_ms, 10) || 0) / 1000}s` : '')));
    if (n.prompt || n.title) node.append(el('div', null, str(n.prompt || n.title)));
    const groups = n.options || (n.correct || n.decoys ? [n.correct || [], n.decoys || []] : null);
    if (Array.isArray(groups) && full) groups.forEach((g, i) =>
      node.append(el('div', 'emo', `${groups.length === 2 ? (i ? 'Decoys' : 'Correct') : 'Group ' + (i + 1)}: ${Array.isArray(g) ? g.join(', ') : str(g)}`)));
    const rounds = n.setup?.rounds;
    if (Array.isArray(rounds)) node.append(el('div', 'emo', `${rounds.length} round(s) from the ${n.setup.bank} bank` +
      (Array.isArray(n.variants) ? `; ${n.variants.map(v => v.platform + ' ' + v.bank).join(', ')}` : '')));
    if (full && Array.isArray(rounds)) rounds.slice(0, 12).forEach(r => node.append(el('div', 'emo',
      trunc(str(r.subtitle || r.question || '') + ': ' + (r.correct || r.words || r.options || []).join(', '), 140))));
    if (Array.isArray(n.words) && full) node.append(el('div', 'emo', trunc(n.words.join(' | '), 400)));
  } else if (t === 'score_tier') {
    node = el('div', 'tier-box');
    node.append(el('div', 'box-label', `Rank by var ${n.var} (one is shown)`));
    const ol = el('ol');
    (n.tiers || []).forEach(x => ol.append(el('li', null, `${trunc(str(x.rank), 60)} if ${opSym(x.op)} ${x.threshold}`)));
    if (n.default) ol.append(el('li', null, `${trunc(str(n.default.rank || n.default.banner || ''), 60)} otherwise`));
    node.append(ol);
  } else if (t === 'dispatch') node = codeLn(`dispatch on var ${n.state_var} (${(n.arms || []).length} cases)`);
  else if (t === 'random') node = codeLn(`random pick of ${(n.options || []).length}`);
  else if (t === 'checkpoint_replay') node = el('div', 'ln cue', 'Replay from checkpoint');
  else if (t === 'call') {
    node = el('div', 'ln');
    const label = n.routine ? `call ${n.routine}(${(n.args || []).map(a => fmtExpr(a, ctx)).join(', ')})` +
      (n.result_var != null ? ` → var ${n.result_var}` : '') : `call ${n.segment}`;
    node.append(el('span', 'chip call', full ? label : trunc(label, 70)));
  } else if (t === 'return' || t === 'ret') node = el('div', 'ln cue', 'Returns to caller');
  else if (t === 'let') node = codeLn(`${fmtExpr(n.to, ctx)} = ${fmtExpr(n.value, ctx)}`);
  else if (t === 'yield') node = renderYield(n, ctx, full);
  else if (t === 'if') node = codeLn(`if ${fmtExpr(n.cond, ctx)}`);
  else if (t === 'pause') node = el('div', 'ln cue', 'Pause');
  else if (t === 'goto_scene') node = el('div', 'ln cue', `Go to ${segKey(n.file ?? n.to_scene ?? n.script ?? '')}` +
    (isObj(n.section_register) ? ` (var ${n.section_register.var} = ${n.section_register.value})` : ''));
  else if (t === 'background') node = el('div', 'ln cue', `Background ${n.name ? n.name + ' ' : ''}${n.asset_id ?? n.id ?? ''}${n.style === 'custom' ? ' (packaged)' : ''}`);
  else if (t === 'music') node = el('div', 'ln cue', n.action === 'stop' ? 'Music stops' : `Music track ${n.track_id ?? n.id ?? ''}`);
  else if (t === 'sfx') node = el('div', 'ln cue', `Sound ${n.sfx_id ?? n.id ?? ''}`);
  else if (t === 'set_string') node = el('div', 'ln cue', `${n.key} = "${n.value}"`);
  else if (t === 'string_default') node = el('div', 'ln cue', `${n.key} defaults to "${n.default}"`);
  else if (t === 'text_input') node = el('div', 'ln', `Player types: ${n.prompt || n.title || ''}`);
  else if (t === 'character_picker') node = el('div', 'ln', `Player picks a character: ${n.prompt || ''}`);
  else if (t === 'pov_change') node = el('div', 'ln cue', `Now playing as ${n.character}`);
  else if (t === 'set_expression') node = el('div', 'ln cue', `Character ${n.character_id} expression ${n.expression}`);
  else if (t === 'next' || t === 'end') node = el('div', 'ln cue', t === 'end' ? 'End' : `Continue to ${segKey(n.next)}`);
  else node = el('div', 'ln cue', `${t || 'node'}${n.text ? ': ' + n.text : ''}`);
  if (n.when && node) {
    const w = el('span', 'chip check', `only if ${fmtWhen(n.when)}`); w.style.marginRight = '5px';
    node.prepend(w);
  }
  return node;
}

function isCue(n) {
  if (!isObj(n)) return false;
  if (CUE_TYPES.has(n.type)) return true;
  if (n.type === 'next' || n.type === 'end') return true;
  if (n.type === 'yield') return CUE_YIELDS.has(parseInt(n.yield, 10));
  return false;
}

function terminalText(m, seg) {
  const outs = m.out.get(seg.id) || [];
  const last = [...seg.nodes].reverse().find(isObj);
  const kinds = new Set(outs.map(e => e.kind));
  if (last && (last.type === 'return' || last.type === 'ret')) return 'Returns to caller';
  if (!outs.length) return seg.end ? (last?.type === 'end' ? 'Scene ends' : 'Flow ends') : 'No further links';
  if (kinds.has('win') || kinds.has('lose')) return 'Minigame result decides';
  if (kinds.has('case')) return 'Dispatches on a variable';
  if (kinds.has('random')) return 'Random pick';
  if (kinds.has('then')) return `Checks ${trunc(outs.find(e => e.cond)?.cond || 'a condition', 40)}`;
  if (kinds.has('option')) return `${outs.filter(e => e.kind === 'option').length} choice links`;
  if (kinds.has('goto')) return `Goes to ${outs.find(e => e.kind === 'goto').label}`;
  if (kinds.has('replay')) return 'Replays from checkpoint';
  if (kinds.has('call') && outs.every(e => e.kind === 'call')) return 'Calls, then stops';
  return 'Continues';
}

function segCard(seg) {
  const m = state.model;
  const c = el('div', 'card segcard' + (seg.routine ? ' ir' : ''));
  c.dataset.id = seg.id;
  const h = el('div', 'card-head');
  h.append(el('span', 'id', seg.id));
  const lc = m.lineCount(seg);
  h.append(el('span', 'meta', seg.routine ? `${seg.nodes.length} ops` : `${lc} ${lc === 1 ? 'line' : 'lines'}`));
  c.append(h);
  if (seg.badges.length) {
    const b = el('div', 'badges');
    seg.badges.forEach(x => b.append(el('span', `badge ${x.cls}`, x.text)));
    c.append(b);
  }
  const body = el('div', 'card-body');
  const visible = seg.nodes.filter(n => state.showCues || !isCue(n));
  const cap = state.cap || Infinity;
  let shown = 0, hidden = 0;
  for (const n of visible) {
    const heavy = isObj(n) && ['choice', 'minigame', 'score_tier'].includes(n.type);
    if (shown < cap || heavy) { body.append(renderNode(n, false, seg.ctx)); if (!heavy) shown++; }
    else hidden++;
  }
  if (!visible.length) body.append(el('div', 'ln cue', seg.nodes.length ? `${seg.nodes.length} cues and links` : 'Empty segment'));
  if (hidden) body.append(el('div', 'more', `${hidden} more, open to read all`));
  c.append(body);
  c.append(el('div', 'card-foot', terminalText(m, seg)));
  return c;
}

function portalCard(p) {
  const c = el('div', 'card portal' + (p.call ? ' callp' : ''));
  c.dataset.id = p.id; c.dataset.target = p.target || '';
  c.append(el('div', 'card-body', p.text));
  return c;
}

function sceneCard(sc) {
  const m = state.model;
  const c = el('div', 'card scene' + (sc.kind === 'routine' ? ' routine' : ''));
  c.dataset.id = 'scene:' + sc.id; c.dataset.scene = sc.id;
  const h = el('div', 'card-head'); h.append(el('span', 'id', sc.label));
  if (sc.meta.protagonist) h.append(el('span', 'meta', `as ${sc.meta.protagonist}`));
  c.append(h);
  const b = el('div', 'card-body');
  let lines = 0, choices = 0, games = 0, gates = 0; const speakers = new Map();
  for (const id of sc.segIds) {
    const s = m.segs.get(id);
    lines += m.lineCount(s);
    s.nodes.forEach(n => {
      if (!isObj(n)) return;
      if (n.type === 'choice') choices++;
      if (n.type === 'yield' && [1, 4].includes(parseInt(n.yield, 10))) choices++;
      if (n.type === 'minigame' || (n.type === 'yield' && [71, 94, 96, 70].includes(parseInt(n.yield, 10)))) games++;
      if (['gate', 'if', 'dispatch', 'score_tier'].includes(n.type)) gates++;
      const spk = n.type === 'dialogue' ? n.speaker : (n.type === 'yield' && parseInt(n.yield, 10) !== 65 ? n.speaker : null);
      if (spk) speakers.set(spk, (speakers.get(spk) || 0) + 1);
    });
  }
  const stats = el('div', 'scene-stats');
  [[lines, 'lines'], [choices, 'choices'], [games, 'minigames'], [gates, 'checks']].forEach(([v, l]) => {
    const d = el('div'); d.append(el('b', null, String(v)), el('span', null, l)); stats.append(d);
  });
  b.append(stats);
  if (sc.kind === 'routine') b.append(el('div', 'ln muted', `Exact code, ${sc.meta.params || 0} argument(s), from bytecode offset ${sc.meta.offset ?? '?'}`));
  if (sc.meta.gate) { const g = el('div', 'ln'); g.append(el('span', 'chip check', `Runs when ${fmtCond(sc.meta.gate)}`)); b.append(g); }
  const reg = sc.meta.setup?.characters?.map(x => x.name).filter(Boolean) || [];
  const top = reg.length ? reg : [...speakers.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 5).map(x => x[0]);
  if (top.length) b.append(el('div', 'ln muted', `${reg.length ? 'Cast' : 'Speakers'}: ${top.slice(0, 6).join(', ')}`));
  const first = m.segs.get(sc.entry);
  const firstLine = first && first.nodes.find(n => isObj(n) && (n.type === 'dialogue' || n.type === 'narration'));
  if (firstLine) b.append(renderNode(firstLine));
  c.append(b);
  c.append(el('div', 'card-foot', `${sc.segIds.length} segments. Open ${sc.kind === 'routine' ? 'routine' : 'scene'} flow`));
  return c;
}

// ------------------------------------------------------------------ graph building
function groupVisible(g) { return state.showRoutines || g.kind !== 'routine'; }

function buildGraph() {
  const m = state.model;
  const nodes = [], edges = [];
  if (state.view === 'overview') {
    for (const sc of m.scenes.values()) if (groupVisible(sc)) nodes.push({ id: 'scene:' + sc.id, kind: 'scene', sc });
    const agg = new Map();
    for (const e of m.edges) {
      const a = m.sceneOf(e.from), b = m.sceneOf(e.to);
      if (a == null || b == null || a === b) continue;
      if (!groupVisible(m.group(a)) || !groupVisible(m.group(b))) continue;
      const key = `${a}>${b}>${e.kind}`;
      if (!agg.has(key)) agg.set(key, { from: 'scene:' + a, to: 'scene:' + b, kind: e.kind, n: 0, inferred: true });
      const g = agg.get(key); g.n++; g.inferred = g.inferred && !!e.inferred;
    }
    for (const g of agg.values()) {
      const base = g.kind === 'goto' ? 'jump' : g.kind === 'call' ? 'calls' : (KINDS[g.kind]?.label || g.kind);
      edges.push({ from: g.from, to: g.to, kind: g.kind, label: base + (g.n > 1 ? ' ×' + g.n : ''), inferred: g.inferred });
    }
    return { nodes, edges };
  }
  const inView = id => {
    const g = m.group(m.sceneOf(id));
    return state.view === 'all' ? (g ? groupVisible(g) : true) : m.sceneOf(id) === state.scene;
  };
  const segIds = state.view === 'all' ? [...m.segs.keys()].filter(inView) : (m.scenes.get(state.scene)?.segIds || []);
  segIds.forEach(id => nodes.push({ id, kind: 'seg', seg: m.segs.get(id) }));
  const portals = new Map();
  const portal = (id, text, target, call) => { if (!portals.has(id)) portals.set(id, { id, kind: 'portal', text, target, call }); return id; };
  for (const id of segIds) for (const e of m.out.get(id) || []) {
    if (!m.segs.has(e.to)) edges.push({ ...e, to: portal('missing:' + e.to, `Missing segment ${e.to}`, null) });
    else if (inView(e.to)) edges.push(e);
    else {
      const g = m.group(m.sceneOf(e.to));
      edges.push({ ...e, to: portal(`out:${e.to}`, `${e.kind === 'call' ? 'Calls' : 'Continue in'} ${g?.label || '?'} at ${e.to}`, e.to, e.kind === 'call') });
    }
  }
  if (state.view === 'scene') {
    for (const id of segIds) for (const e of m.inc.get(id) || []) {
      if (inView(e.from)) continue;
      const g = m.group(m.sceneOf(e.from));
      edges.push({ ...e, from: portal(`in:${g?.id}:${e.kind === 'call'}`, `${e.kind === 'call' ? 'Called from' : 'From'} ${g?.label || '?'}`, e.from, e.kind === 'call') });
    }
  }
  portals.forEach(p => nodes.push(p));
  return { nodes, edges };
}

// ------------------------------------------------------------------ layout + draw
function ensureMarkers() {
  const defs = $('#markers'); if (defs.childNodes.length) return;
  for (const k of Object.keys(KINDS)) {
    const mk = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    mk.setAttribute('id', 'arrow-' + k); mk.setAttribute('viewBox', '0 0 10 10');
    mk.setAttribute('refX', '9'); mk.setAttribute('refY', '5');
    mk.setAttribute('markerWidth', '7'); mk.setAttribute('markerHeight', '7'); mk.setAttribute('orient', 'auto-start-reverse');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M0,0 L10,5 L0,10 z'); p.style.fill = `var(${KINDS[k].color})`;
    mk.append(p); defs.append(mk);
  }
}

function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0].x},${pts[0].y}`;
  if (pts.length === 2) return d + ` L${pts[1].x},${pts[1].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], n = pts[i + 1];
    const mx = (p.x + n.x) / 2, my = (p.y + n.y) / 2;
    d += i === pts.length - 2 ? ` Q${p.x},${p.y} ${n.x},${n.y}` : ` Q${p.x},${p.y} ${mx},${my}`;
  }
  return d;
}

function render({ keepView = false } = {}) {
  const m = state.model;
  world.querySelectorAll('.card, .elabel').forEach(x => x.remove());
  svg.querySelectorAll(':scope > path').forEach(x => x.remove());
  $('#empty').hidden = !!m;
  if (!m) return;
  ensureMarkers();
  const g = buildGraph();
  state.graph = g;

  const cards = new Map();
  const frag = document.createDocumentFragment();
  for (const n of g.nodes) {
    const c = n.kind === 'seg' ? segCard(n.seg) : n.kind === 'scene' ? sceneCard(n.sc) : portalCard(n);
    c.style.visibility = 'hidden'; cards.set(n.id, c); frag.append(c);
  }
  const labels = g.edges.map(e => {
    if (!e.label && !(e.effects && e.effects.length) && !e.guard) return null;
    const l = el('div', 'elabel');
    l.style.color = `var(${KINDS[e.kind]?.color || '--k-other'})`;
    l.append(document.createTextNode(trunc(str(e.label || ''), 60)));
    if (e.effects && e.effects.length) l.append(el('span', 'fx', e.effects.map(fmtEffect).join(', ')));
    if (e.guard) l.append(el('span', 'fx', e.guard));
    if (e.inferred) l.title = 'Inferred from layout, not an explicit link in the JSON';
    l.style.visibility = 'hidden'; frag.append(l);
    return l;
  });
  world.append(frag);

  const G = new dagre.graphlib.Graph({ multigraph: true });
  G.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 64, edgesep: 14, marginx: 40, marginy: 40 });
  G.setDefaultEdgeLabel(() => ({}));
  for (const n of g.nodes) {
    const c = cards.get(n.id);
    G.setNode(n.id, { width: c.offsetWidth, height: c.offsetHeight });
  }
  g.edges.forEach((e, i) => {
    if (!G.hasNode(e.from) || !G.hasNode(e.to)) return;
    const l = labels[i];
    G.setEdge(e.from, e.to, { width: l ? l.offsetWidth : 0, height: l ? l.offsetHeight : 0, labelpos: 'c',
      minlen: e.kind === 'goto' ? 2 : 1 }, 'e' + i);
  });
  dagre.layout(G);

  for (const n of g.nodes) {
    const p = G.node(n.id), c = cards.get(n.id);
    c.style.left = (p.x - p.width / 2) + 'px'; c.style.top = (p.y - p.height / 2) + 'px'; c.style.visibility = '';
  }
  const gg = G.graph();
  svg.setAttribute('width', gg.width); svg.setAttribute('height', gg.height);
  world.style.width = gg.width + 'px'; world.style.height = gg.height + 'px';
  state.bounds = { w: gg.width, h: gg.height };
  g.edges.forEach((e, i) => {
    if (!G.hasNode(e.from) || !G.hasNode(e.to)) return;
    const ed = G.edge({ v: e.from, w: e.to, name: 'e' + i });
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const kd = KINDS[e.kind] || KINDS.other;
    path.setAttribute('d', smoothPath(ed.points));
    path.style.stroke = `var(${kd.color})`;
    const dash = e.inferred ? INFERRED_DASH : kd.dash;
    if (dash) path.setAttribute('stroke-dasharray', dash);
    path.setAttribute('marker-end', `url(#arrow-${KINDS[e.kind] ? e.kind : 'other'})`);
    path.dataset.from = e.from; path.dataset.to = e.to;
    svg.append(path);
    const l = labels[i];
    if (l) { l.style.left = ed.x + 'px'; l.style.top = ed.y + 'px'; l.style.visibility = ''; l.dataset.from = e.from; l.dataset.to = e.to; }
  });
  labels.forEach(l => { if (l && l.style.visibility === 'hidden') l.remove(); });

  applySelection();
  if (!keepView) {
    if (state.sel && cards.has(state.sel)) centerOn(state.sel); else fit();
  } else applyTransform();
}

// ------------------------------------------------------------------ view transform
function applyTransform() { world.style.transform = `translate(${state.tx}px,${state.ty}px) scale(${state.k})`; }
function fit() {
  if (!state.bounds) return;
  const r = stage.getBoundingClientRect();
  const k = Math.min(1.2, Math.max(0.05, Math.min(r.width / state.bounds.w, r.height / state.bounds.h) * 0.95));
  state.k = k;
  state.tx = (r.width - state.bounds.w * k) / 2;
  state.ty = Math.max(10, (r.height - state.bounds.h * k) / 2);
  applyTransform();
}
function zoomAt(f, cx, cy) {
  const k = Math.min(3, Math.max(0.04, state.k * f));
  const r = stage.getBoundingClientRect();
  cx = cx ?? r.width / 2; cy = cy ?? r.height / 2;
  state.tx = cx - (cx - state.tx) * (k / state.k);
  state.ty = cy - (cy - state.ty) * (k / state.k);
  state.k = k; applyTransform();
}
function centerOn(id, flash) {
  const c = world.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!c) return;
  const r = stage.getBoundingClientRect();
  if (state.k < 0.6) state.k = 0.9;
  const x = c.offsetLeft + c.offsetWidth / 2, y = c.offsetTop + Math.min(c.offsetHeight / 2, r.height / 3);
  state.tx = r.width / 2 - x * state.k; state.ty = r.height / 2 - y * state.k;
  applyTransform();
  if (flash) { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
}

// ------------------------------------------------------------------ selection + inspector
function applySelection() {
  const sel = state.sel;
  const near = new Set();
  const paths = svg.querySelectorAll(':scope > path');
  if (sel) {
    near.add(sel);
    paths.forEach(p => { if (p.dataset.from === sel) near.add(p.dataset.to); if (p.dataset.to === sel) near.add(p.dataset.from); });
  }
  world.querySelectorAll('.card').forEach(c => {
    c.classList.toggle('sel', c.dataset.id === sel);
    c.classList.toggle('dim', !!sel && !near.has(c.dataset.id));
  });
  paths.forEach(p => {
    const hot = sel && (p.dataset.from === sel || p.dataset.to === sel);
    p.classList.toggle('hot', !!hot); p.classList.toggle('dim', !!sel && !hot);
  });
  world.querySelectorAll('.elabel').forEach(l => l.classList.toggle('dim', !!sel && l.dataset.from !== sel && l.dataset.to !== sel));
}

function linkRow(e, dir) {
  const m = state.model;
  const other = dir === 'out' ? e.to : e.from;
  const b = el('button', 'linkrow');
  const kd = KINDS[e.kind] || KINDS.other;
  b.style.setProperty('--kc', `var(${kd.color})`);
  b.append(el('span', 'k', e.kind === 'option' ? 'Option' : kd.label));
  const og = m.group(m.sceneOf(other)), sg = m.group(m.sceneOf(dir === 'out' ? e.from : e.to));
  const txt = [e.label && !['next', 'goto'].includes(e.kind) ? `"${e.label}"` : null,
    e.guard || null,
    e.effects && e.effects.length ? `sets ${e.effects.map(fmtEffect).join(', ')}` : null,
    `${dir === 'out' ? 'to' : 'from'} ${other}`,
    og !== sg ? `(${og?.label || 'missing'})` : null,
    e.inferred ? '(inferred)' : null].filter(Boolean).join(' ');
  b.append(el('span', 'd', txt));
  b.onclick = () => goToSeg(other);
  return b;
}

function openInspector(id, hlText) {
  const m = state.model; const seg = m.segs.get(id);
  const body = $('#inspBody'); body.textContent = '';
  if (!seg) { $('#inspector').hidden = true; return; }
  $('#inspector').hidden = false;
  $('#inspTitle').textContent = seg.id;
  body.append(el('div', 'muted', `${m.group(seg.scene)?.label || ''}, ${m.lineCount(seg)} lines, ${seg.nodes.length} nodes`));
  seg.badges.forEach(b => body.append(el('span', `badge ${b.cls}`, b.text)));
  const outs = m.out.get(id) || [], ins = m.inc.get(id) || [];
  body.append(el('h3', null, 'Leads to'));
  if (outs.length) outs.forEach(e => body.append(linkRow(e, 'out')));
  else body.append(el('div', 'muted', seg.end ? 'The flow stops here.' : 'No outgoing links in the JSON.'));
  body.append(el('h3', null, seg.routine ? 'Code' : 'Script'));
  let hlEl = null;
  seg.nodes.forEach(n => {
    const r = renderNode(n, true, seg.ctx);
    if (isObj(n) && n.offset != null) r.append(el('span', 'off', `@${n.offset}`));
    if (isObj(n) && n.image != null && n.image !== 'null') r.append(el('span', 'off', `img ${n.image}`));
    if (hlText && isObj(n) && (str(n.text) === hlText || nodeTexts(n).includes(hlText))) { r.classList.add('hl'); hlEl = hlEl || r; }
    body.append(r);
  });
  body.append(el('h3', null, 'Reached from'));
  if (ins.length) ins.forEach(e => body.append(linkRow(e, 'in')));
  else body.append(el('div', 'muted', id === m.entry ? 'Episode start.' : 'Nothing links here.'));
  const det = el('details'); det.append(el('summary', null, 'Raw JSON'));
  det.append(el('pre', null, JSON.stringify(seg.raw || { nodes: seg.nodes }, null, 1)));
  body.append(det);
  if (hlEl) hlEl.scrollIntoView({ block: 'center' });
}

function select(id, opts = {}) {
  state.sel = id;
  applySelection();
  if (id && state.model.segs.has(id)) openInspector(id, opts.hlText);
  else $('#inspector').hidden = true;
  writeHash();
}

function goToSeg(id, hlText) {
  const m = state.model;
  if (!m.segs.has(id)) return;
  const sc = m.sceneOf(id);
  state.sel = id;
  const hiddenInAll = state.view === 'all' && !groupVisible(m.group(sc));
  if (state.view === 'overview' || (state.view === 'scene' && state.scene !== sc) || hiddenInAll) {
    state.view = 'scene'; state.scene = sc; syncControls(); render(); renderSide();
  }
  select(id, { hlText });
  centerOn(id, true);
}

// ------------------------------------------------------------------ side panels
function nodeTexts(n) {
  const out = [];
  if (!isObj(n)) return out;
  for (const k of ['text', 'title', 'subtitle', 'prompt']) if (isStr(n[k])) out.push(n[k]);
  if (Array.isArray(n.options)) n.options.forEach(o => isObj(o) && isStr(o.label) && out.push(o.label));
  const deep = v => { if (Array.isArray(v)) v.forEach(deep); else if (isObj(v)) { if (isStr(v.text)) out.push(v.text); Object.values(v).forEach(x => (isObj(x) || Array.isArray(x)) && deep(x)); } };
  if (n.type === 'yield' || n.type === 'call' || n.type === 'let') deep([n.args, n.value]);
  if (isObj(n.format) && isStr(n.format.pattern) && !out.includes(n.format.pattern)) out.push(n.format.pattern);
  if (Array.isArray(n.tiers)) n.tiers.forEach(t => isStr(t.rank) && out.push(t.rank));
  return out;
}

function renderSide() {
  const m = state.model;
  const sp = $('#scenesPanel'); sp.textContent = '';
  const vp = $('#varsPanel'); vp.textContent = '';
  $('#epInfo').textContent = '';
  if (!m) { sp.append(el('p', 'muted', 'No episode loaded.')); return; }
  let lastKind = null;
  for (const sc of m.scenes.values()) {
    if (sc.kind !== lastKind && sc.kind === 'routine') sp.append(el('div', 'side-h', 'Routines (exact code)'));
    lastKind = sc.kind;
    const b = el('button', 'list-item');
    b.append(el('span', 't', sc.label));
    const lines = sc.segIds.reduce((a, id) => a + m.lineCount(m.segs.get(id)), 0);
    b.append(el('span', 's', `${sc.segIds.length} segments, ${lines} lines` + (sc.meta.gate ? `, runs when ${fmtCond(sc.meta.gate)}` : '') +
      (sc.kind === 'routine' ? `, ${sc.meta.params || 0} args` : '')));
    b.setAttribute('aria-current', state.view === 'scene' && state.scene === sc.id ? 'true' : 'false');
    b.onclick = () => { state.view = 'scene'; state.scene = sc.id; state.sel = null; syncControls(); render(); renderSide(); writeHash(); closeSideNarrow(); };
    sp.append(b);
  }

  // variables
  if (!m.vars.size && !m.names.size) vp.append(el('p', 'muted', 'No variable writes or checks found in this file.'));
  const order = { check: 0, set: 1, add: 2, read: 3 };
  const vd = m.varDefaults;
  const setOnly = new Set((vd?.set_only || []).map(str));
  [...m.vars.keys()].sort(numSort).forEach(name => {
    const blk = el('div', 'var-block');
    const h = el('h3', null, /^\d+$/.test(name) ? `var ${name}` : name);
    const extra = [];
    if (vd?.values && name in vd.values) extra.push(`starts at ${vd.values[name]}`);
    if (setOnly.has(name)) extra.push('only assigned');
    if (extra.length) h.append(el('span', 'muted', extra.join(', ')));
    blk.append(h);
    const recs = m.vars.get(name).slice().sort((a, b) => order[a.kind] - order[b.kind]);
    if (!recs.length) blk.append(el('div', 'var-row muted', 'Listed in variable_defaults; not touched by a story node.'));
    recs.forEach(r => {
      const row = el('button', `list-item var-row ${r.kind === 'check' ? 'check' : r.kind === 'read' ? 'read' : 'set'}`);
      row.append(el('span', 'op', { check: 'checks ', set: 'sets ', add: 'changes ', read: 'reads ' }[r.kind]));
      row.append(document.createTextNode(`${r.text} in ${r.seg}`));
      row.onclick = () => { goToSeg(r.seg); closeSideNarrow(); };
      blk.append(row);
    });
    vp.append(blk);
  });
  if (m.names.size) {
    vp.append(el('div', 'side-h', 'Name placeholders'));
    for (const [k, v] of m.names) {
      const blk = el('div', 'var-block'); blk.append(el('h3', null, k));
      if (v.default != null) blk.append(el('div', 'var-row', `default "${v.default}"`));
      if (Array.isArray(v.set_to) && v.set_to.length) blk.append(el('div', 'var-row', `set to ${v.set_to.map(x => `"${x}"`).join(', ')}`));
      if (v.from_player_input) blk.append(el('div', 'var-row', 'typed in by the player'));
      vp.append(blk);
    }
  }

  const info = $('#epInfo');
  const nr = Object.keys(m.routines || {}).length;
  info.append(el('div', null, `${m.segs.size} segments, ${m.edges.length} links, ${[...m.scenes.values()].filter(g => g.kind !== 'routine').length} scenes` + (nr ? `, ${nr} routines.` : '.')));
  if (m.raw.pack_id != null) info.append(el('div', null, `Pack ${m.raw.pack_id}, episode ${m.raw.episode_id ?? '?'}.`));
  if (m.missing.length) info.append(el('div', null, `${m.missing.length} links point at segments that are not in the file.`));
  m.notes.forEach(n => info.append(el('div', 'note', n)));
}

function runSearch() {
  const q = $('#searchInput').value.trim().toLowerCase();
  const out = $('#searchResults'); out.textContent = '';
  const m = state.model; if (!m || q.length < 2) return;
  let count = 0;
  for (const seg of m.segs.values()) {
    const segHit = seg.id.toLowerCase().includes(q);
    for (const n of seg.nodes) {
      if (!isObj(n)) continue;
      const texts = nodeTexts(n);
      const who = str(n.speaker);
      const text = texts.find(t => t.toLowerCase().includes(q)) || (who.toLowerCase().includes(q) || segHit ? texts[0] || '' : null);
      if (text == null) continue;
      const b = el('button', 'list-item result');
      b.append(el('span', 't', `${who || (n.type === 'narration' ? 'Narration' : n.name || n.type)} in ${seg.id}`));
      const s = el('span', 's'); const i = text.toLowerCase().indexOf(q);
      if (i >= 0) { s.append(text.slice(0, i)); s.append(el('mark', null, text.slice(i, i + q.length))); s.append(trunc(text.slice(i + q.length), 120)); }
      else s.append(trunc(text, 120));
      b.append(s);
      b.onclick = () => { goToSeg(seg.id, text); closeSideNarrow(); };
      out.append(b);
      if (++count >= 200) { out.append(el('p', 'muted', 'Showing the first 200 matches.')); return; }
      if (segHit) break;
    }
  }
  if (!count) out.append(el('p', 'muted', 'No matches.'));
}

// ------------------------------------------------------------------ controls + hash
function syncControls() {
  document.querySelectorAll('#viewSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  const ss = $('#sceneSelect');
  ss.hidden = state.view !== 'scene';
  if (state.model && ss.options.length !== state.model.scenes.size) {
    ss.textContent = '';
    for (const sc of state.model.scenes.values()) { const o = el('option', null, sc.label); o.value = sc.id; ss.append(o); }
  }
  if (state.scene != null) ss.value = state.scene;
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.epPath) p.set('ep', state.epPath);
  p.set('view', state.view);
  if (state.view === 'scene' && state.scene != null) p.set('scene', state.scene);
  if (state.sel) p.set('seg', state.sel);
  history.replaceState(null, '', '#' + p.toString());
}
function readHash() { return new URLSearchParams(location.hash.slice(1)); }

function loadModel(raw, name, epPath, fromHash) {
  let m;
  try { m = new Model(raw, name); }
  catch (err) { showError(`${name}: ${err.message}`); return; }
  showError('');
  state.model = m; state.epPath = epPath || null; state.sel = null;
  state.view = 'overview'; state.scene = m.sceneOf(m.entry) ?? m.scenes.keys().next().value;
  if (fromHash) {
    const h = readHash();
    if (['overview', 'scene', 'all'].includes(h.get('view'))) state.view = h.get('view');
    if (h.get('scene') && m.scenes.has(h.get('scene'))) state.scene = h.get('scene');
    if (h.get('seg') && m.segs.has(h.get('seg'))) { state.sel = h.get('seg'); state.scene = m.sceneOf(state.sel); if (state.view === 'overview') state.view = 'scene'; }
  }
  document.title = `${m.title} | SHS Story Map`;
  $('#inspector').hidden = true;
  syncControls(); renderSide(); render();
  if (state.sel) select(state.sel);
  writeHash();
}

function showError(msg) { $('#loadErr').textContent = msg; if (msg) { state.model = null; render(); renderSide(); } }

async function loadUrl(path, fromHash) {
  try {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    loadModel(await r.json(), path.split('/').pop(), path, fromHash);
    syncPickers(path);
  } catch (err) { showError(`Could not load ${path}: ${err.message}`); }
}

function loadFile(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try { loadModel(JSON.parse(rd.result), file.name, null, false); $('#epSelect').value = ''; }
    catch (err) { showError(`${file.name} is not valid JSON: ${err.message}`); }
  };
  rd.readAsText(file);
}

// ------------------------------------------------------------------ episode catalog
// episodes/<GAME>/<Season>/<episode>.json  ->  game picker + episode picker grouped by season.
// Source: episodes/index.json (written by tools/make_manifest.py); when that is missing or empty on a
// *.github.io site, the repository tree is read from the GitHub API instead.
const GAME_TITLES = { SHS: 'Surviving High School', COD: 'Cause of Death' };
const catalog = { games: [] };

function firstNum(s) { const m = /\d+/.exec(str(s)); return m ? parseInt(m[0], 10) : Infinity; }
function natural(a, b) {
  const na = firstNum(a), nb = firstNum(b);
  return na !== nb ? na - nb : str(a).localeCompare(str(b), undefined, { numeric: true, sensitivity: 'base' });
}
function prettySeason(id) {
  if (!id) return 'Episodes';
  const t = id.replace(/[_-]+/g, ' ').trim();
  if (/^\d+$/.test(t)) return 'Season ' + parseInt(t, 10);
  if (/^s\s*\d+$/i.test(t)) return 'Season ' + firstNum(t);
  return t;
}
function prettyEpisode(file) {
  return file.split('/').pop().replace(/\.json$/i, '').replace(/_/g, ' ').replace(/^(\d+)\s+/, '$1: ');
}

// items: [{ file: 'SHS/Season 1/x.json' (relative to episodes/), title?, episode_id?, pack_id? }]
function buildCatalog(items) {
  const games = new Map();
  for (const it of items) {
    const rel = str(it.file).replace(/^\.?\/?(episodes\/)?/, '');
    if (!/\.json$/i.test(rel) || /(^|\/)index\.json$/i.test(rel)) continue;
    const parts = rel.split('/');
    const game = parts.length > 1 ? parts[0] : '';
    const season = parts.length > 2 ? parts.slice(1, -1).join('/') : '';
    if (!games.has(game)) games.set(game, new Map());
    const seasons = games.get(game);
    if (!seasons.has(season)) seasons.set(season, []);
    seasons.get(season).push({
      path: 'episodes/' + rel, title: it.title || prettyEpisode(rel),
      order: it.episode_id != null && it.episode_id !== '' && +it.episode_id > 0 ? +it.episode_id : firstNum(rel.split('/').pop()),
      name: rel.split('/').pop(),
    });
  }
  catalog.games = [...games.entries()].sort((a, b) => {
    const order = ['SHS', 'COD'];
    const ia = order.indexOf(a[0].toUpperCase()), ib = order.indexOf(b[0].toUpperCase());
    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib) || natural(a[0], b[0]);
  }).map(([id, seasons]) => ({
    id, title: GAME_TITLES[id.toUpperCase()] || (id ? id.replace(/[_-]+/g, ' ') : 'Episodes'),
    seasons: [...seasons.entries()].sort((a, b) => (a[0] === '') - (b[0] === '') || natural(a[0], b[0]))
      .map(([sid, eps]) => ({ id: sid, title: prettySeason(sid),
        episodes: eps.sort((a, b) => (a.order - b.order) || natural(a.name, b.name)) })),
  }));
  return catalog.games.reduce((n, g) => n + g.seasons.reduce((m, s) => m + s.episodes.length, 0), 0);
}

async function catalogFromGitHub() {
  const host = location.hostname;
  if (!/\.github\.io$/i.test(host)) return [];
  const owner = host.split('.')[0];
  const first = location.pathname.split('/').filter(Boolean)[0];
  const candidates = first && !/\.html?$/i.test(first) ? [first, `${owner}.github.io`] : [`${owner}.github.io`];
  for (const repo of candidates) {
    try {
      const info = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
      if (!info.ok) continue;
      const branch = (await info.json()).default_branch;
      const tr = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      if (!tr.ok) continue;
      const paths = ((await tr.json()).tree || []).filter(t => t.type === 'blob').map(t => t.path);
      // the site folder is the one holding app.js next to an episodes/ folder (repo root or docs/)
      const roots = paths.filter(p => /(^|\/)app\.js$/.test(p)).map(p => p.slice(0, -'app.js'.length));
      const root = roots.find(r => paths.some(p => p.startsWith(r + 'episodes/'))) ?? '';
      return paths.filter(p => p.startsWith(root + 'episodes/') && /\.json$/i.test(p))
        .map(p => ({ file: p.slice((root + 'episodes/').length) }));
    } catch { /* try the next candidate */ }
  }
  return [];
}

async function loadManifest() {
  let items = [];
  try {
    const r = await fetch('episodes/index.json', { cache: 'no-cache' });
    if (r.ok) {
      const data = await r.json();
      items = Array.isArray(data) ? data : (data.episodes || []);
      items = items.map(it => (typeof it === 'string' ? { file: it } : it));
    }
  } catch { /* fall through */ }
  if (!buildCatalog(items)) buildCatalog(await catalogFromGitHub());
  fillGameSelect();
  return catalog.games.flatMap(g => g.seasons.flatMap(s => s.episodes.map(e => e.path)));
}

function gameOfPath(path) { return catalog.games.find(g => g.seasons.some(s => s.episodes.some(e => e.path === path))); }

function fillGameSelect(gameId) {
  const gs = $('#gameSelect');
  gs.textContent = '';
  for (const g of catalog.games) { const o = el('option', null, g.title); o.value = g.id; gs.append(o); }
  gs.hidden = catalog.games.length < 2;
  let pick = gameId;
  if (pick == null) { try { pick = localStorage.getItem('shs-map-game'); } catch {} }
  if (!catalog.games.some(g => g.id === pick)) pick = catalog.games[0]?.id ?? '';
  gs.value = pick;
  fillEpisodeSelect(pick);
}

function fillEpisodeSelect(gameId) {
  const sel = $('#epSelect');
  const keep = sel.value;
  sel.textContent = '';
  sel.append(Object.assign(el('option', null, catalog.games.length ? 'Choose an episode…' : 'No episodes listed'), { value: '' }));
  const g = catalog.games.find(x => x.id === gameId);
  if (g) for (const s of g.seasons) {
    const grp = document.createElement('optgroup'); grp.label = s.title;
    for (const e of s.episodes) { const o = el('option', null, e.title); o.value = e.path; grp.append(o); }
    sel.append(grp);
  }
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}

function syncPickers(path) {
  const g = gameOfPath(path);
  if (g && $('#gameSelect').value !== g.id) { $('#gameSelect').value = g.id; fillEpisodeSelect(g.id); }
  $('#epSelect').value = path || '';
}

function closeSideNarrow() { $('#side').classList.remove('open'); }

// ------------------------------------------------------------------ events
function initEvents() {
  $('#gameSelect').onchange = e => { try { localStorage.setItem('shs-map-game', e.target.value); } catch {} fillEpisodeSelect(e.target.value); };
  $('#epSelect').onchange = e => { if (e.target.value) { history.replaceState(null, '', '#'); loadUrl(e.target.value, false); } };
  $('#fileInput').onchange = e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
  document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => {
    if (!state.model) return;
    state.view = b.dataset.view; if (state.view === 'overview') state.sel = null;
    $('#inspector').hidden = !state.sel;
    syncControls(); render(); renderSide(); writeHash();
  });
  $('#sceneSelect').onchange = e => { state.scene = e.target.value; state.sel = null; $('#inspector').hidden = true; render(); renderSide(); writeHash(); };
  $('#cuesToggle').onchange = e => { state.showCues = e.target.checked; render({ keepView: true }); };
  $('#routinesToggle').onchange = e => { state.showRoutines = e.target.checked; if (state.model) render(); };
  $('#capSelect').onchange = e => { state.cap = +e.target.value; render({ keepView: true }); };
  $('#themeBtn').onclick = () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('shs-map-theme', next); } catch {}
  };
  $('#inspClose').onclick = () => select(null);
  $('#toggleSide').onclick = () => $('#side').classList.toggle('open');
  $('#legendToggle').onclick = () => {
    const lg = $('#legend'); lg.classList.toggle('collapsed');
    $('#legendToggle').setAttribute('aria-expanded', String(!lg.classList.contains('collapsed')));
  };
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.tabpanel').forEach(p => (p.hidden = p.dataset.panel !== b.dataset.tab));
    if (b.dataset.tab === 'search') $('#searchInput').focus();
  });
  let st; $('#searchInput').oninput = () => { clearTimeout(st); st = setTimeout(runSearch, 150); };
  $('#zoomIn').onclick = () => zoomAt(1.25);
  $('#zoomOut').onclick = () => zoomAt(0.8);
  $('#zoomFit').onclick = fit;

  const pts = new Map(); let drag = null, pinch = null;
  stage.addEventListener('pointerdown', e => {
    if (e.target.closest('.legend, .zoom, button, select, input, a')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty, moved: false, target: e.target };
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: state.k }; drag = null; }
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()]; const r = stage.getBoundingClientRect();
      zoomAt((pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d) / state.k, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; stage.classList.add('panning'); }
    if (drag.moved) { state.tx = drag.tx + dx; state.ty = drag.ty + dy; applyTransform(); }
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (drag && pts.size === 0) { stage.classList.remove('panning'); if (!drag.moved) onClick(drag.target); drag = null; }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else { state.tx -= e.deltaX; state.ty -= e.deltaY; applyTransform(); }
  }, { passive: false });
  stage.addEventListener('dblclick', e => {
    if (!e.target.closest('.card')) { const r = stage.getBoundingClientRect(); zoomAt(1.4, e.clientX - r.left, e.clientY - r.top); }
  });

  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === '+' || e.key === '=') zoomAt(1.2);
    else if (e.key === '-') zoomAt(1 / 1.2);
    else if (e.key === '0') fit();
    else if (e.key === 'Escape') select(null);
    else if (e.key === '/') { e.preventDefault(); document.querySelector('.tabs [data-tab="search"]').click(); }
    else if (e.key.startsWith('Arrow') && document.activeElement === stage) {
      const d = 60; state.tx += e.key === 'ArrowLeft' ? d : e.key === 'ArrowRight' ? -d : 0;
      state.ty += e.key === 'ArrowUp' ? d : e.key === 'ArrowDown' ? -d : 0; applyTransform(); e.preventDefault();
    }
  });

  let depth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { depth++; $('#dropveil').classList.add('on'); } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('#dropveil').classList.remove('on'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; $('#dropveil').classList.remove('on');
    const f = e.dataTransfer.files[0]; if (f) loadFile(f);
  });
}

function onClick(target) {
  const lbl = target.closest('.elabel');
  if (lbl) { goToSeg(lbl.dataset.to); return; }
  const c = target.closest('.card');
  if (!c) { if (state.sel) select(null); return; }
  if (c.classList.contains('scene')) {
    state.view = 'scene'; state.scene = c.dataset.scene; state.sel = null;
    syncControls(); render(); renderSide(); writeHash(); return;
  }
  if (c.classList.contains('portal')) { if (c.dataset.target) goToSeg(c.dataset.target); return; }
  select(c.dataset.id === state.sel ? null : c.dataset.id);
}

function buildLegend() {
  const ul = $('#legendList');
  for (const k of ['next', 'option', 'timeout', 'then', 'else', 'case', 'win', 'lose', 'goto', 'call']) {
    const li = el('li');
    li.innerHTML = `<svg width="34" height="10"><line x1="1" y1="5" x2="33" y2="5" stroke-width="2.2" style="stroke:var(${KINDS[k].color})" ${KINDS[k].dash ? `stroke-dasharray="${KINDS[k].dash}"` : ''}/></svg>`;
    li.append(el('span', null, KINDS[k].label));
    ul.append(li);
  }
  const li = el('li');
  li.innerHTML = `<svg width="34" height="10"><line x1="1" y1="5" x2="33" y2="5" stroke-width="2.2" style="stroke:var(--k-next)" stroke-dasharray="${INFERRED_DASH}"/></svg>`;
  li.append(el('span', null, 'Inferred link (older format)'));
  ul.append(li);
}

// ------------------------------------------------------------------ boot
(async function boot() {
  try { const t = localStorage.getItem('shs-map-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  buildLegend(); initEvents(); syncControls(); renderSide(); render();
  const eps = await loadManifest();
  const h = readHash();
  if (h.get('ep')) loadUrl(h.get('ep'), true);
  else if (eps.length === 1) loadUrl(eps[0], false);
})();
