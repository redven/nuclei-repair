// ipad_repair/app.js
// Repair crop windows exported by the workstation (src/ipad_batches.py).
// Apple Pencil (or mouse) uses the current tool; fingers pan and pinch-zoom.
// Commits are written back into the batch's repaired/ folder in the training
// format; the workstation merges them into its training crops.

import { CONFIG } from './config.js';
import { DriveStore, LocalStore, outbox } from './store.js';
import { startEngine, Session } from './engine.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const store = params.get('store') === 'local' ? new LocalStore() : new DriveStore();
const decode = (bytes) => new TextDecoder().decode(bytes);
const encode = (obj) => new TextEncoder().encode(JSON.stringify(obj, null, 2));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;',
                                                           '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ tools
const ICONS = {
  paint: '<path d="M3 21c3 0 5-1.5 5-4l-2-2c-2.5 0-4 2-3 6z"/><path d="M8 15 19 4l1 1L9 16"/>',
  erase: '<path d="M7 20h12"/><path d="m4 15 9-9 6 6-7 7H8z"/>',
  pick: '<path d="m14 4 6 6"/><path d="M17 7 6 18l-3 1 1-3L15 5"/>',
  new: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>',
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>' +
       '<path d="M8.5 7.5 20 18M8.5 16.5 20 6"/>',
  merge2d: '<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/>',
  merge3d: '<circle cx="9" cy="10" r="4.5"/><circle cx="15" cy="10" r="4.5"/>' +
           '<path d="M4 18h16M6 21h12"/>',
  delete2d: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>',
  delete3d: '<path d="M5 6h14M10 6V4h4v2M7 6l1 10h8l1-10M6 19h12M8 22h8"/>',
  relabel: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8" r="1.5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
};
const TOOLS = [
  ['paint', 'Paint'], ['erase', 'Erase'], ['pick', 'Pick'], ['new', 'New', 'action'], null,
  ['cut', 'Cut'], ['merge2d', 'Merge'], ['merge3d', 'Merge 3D'], null,
  ['delete2d', 'Delete'], ['delete3d', 'Delete 3D'], ['relabel', 'Relabel'], null,
  ['undo', 'Undo', 'action'],
];
const HINTS = {
  paint: 'Paint the current label', erase: 'Erase to background',
  pick: 'Tap a mask to paint with its label', cut: 'Draw a line across a mask to split it',
  merge2d: 'Tap the mask to keep, then the one to merge into it (this plane)',
  merge3d: 'Tap the mask to keep, then the one to merge into it (all planes)',
  delete2d: 'Tap a mask to delete it in this plane',
  delete3d: 'Tap a mask to delete it in all planes',
  relabel: 'Tap a mask: it gets a new label in this plane',
};

// ------------------------------------------------------------------ state
const state = {
  batchName: '', batch: null, statuses: {}, index: 0,
  session: null, z: 0, img: null, lab: null, edits: 0,
  tool: 'paint', label: 0, brush: 6, opacity: 0.45, contrast: 0,
  outline: false, protect: false, finger: false,
  view: { s: 1, x: 0, y: 0 }, pending: null, stroke: null, hover: null,
};
const canvas = $('view');
const ctx = canvas.getContext('2d');
const plane = document.createElement('canvas');
const pctx = plane.getContext('2d');
let planeImage = null;
const colors = new Map();

function show(screen) {
  for (const id of ['splash', 'batches', 'editor']) $(id).hidden = id !== screen;
}

let messageTimer = 0;
function msg(text, bad = false) {
  const m = $('message');
  m.textContent = text;
  m.className = `message show${bad ? ' bad' : ''}`;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { m.className = 'message'; }, 4500);
}

function device() {
  const ua = navigator.userAgent;
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ipad ? 'iPad' : `browser (${navigator.platform || 'unknown'})`;
}

// Sign in when needed -- called first thing in a tap handler, before any await,
// so Safari lets the Google window open.
function ensureSignedIn() {
  return store.signedIn ? Promise.resolve() : store.signIn();
}

// ------------------------------------------------------------------ start
async function main() {
  buildTools();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' ||
      ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register(`sw.js?v=${CONFIG.version}`).catch(() => {});
  }
  try {
    await startEngine((t) => { $('progress-text').textContent = t; });
  } catch (e) {
    splashError(`Python could not start: ${e.message}`);
    return;
  }
  if (store.signedIn) { showBatches(); return; }
  $('progress').hidden = true;
  $('btn-signin').hidden = false;
}

function splashError(text) {
  $('progress').hidden = true;
  $('splash-error').hidden = false;
  $('splash-error').textContent = text;
}

$('btn-signin').onclick = () => {
  store.signIn().then(showBatches).catch((e) => splashError(e.message));
};

// ------------------------------------------------------------------ batches
async function readJson(path) { return JSON.parse(decode(await store.read(path))); }

async function loadStatuses(name) {
  const files = (await store.list(`batches/${name}/status`))
    .filter((f) => !f.dir && f.name.endsWith('.json'));
  const out = {};
  await Promise.all(files.map(async (f) => {
    out[f.name.slice(0, -5)] = await readJson(`batches/${name}/status/${f.name}`);
  }));
  return out;
}

async function showBatches() {
  show('batches');
  const list = $('batch-list');
  list.innerHTML = '<div class="empty">Loading batches ...</div>';
  try {
    const names = (await store.list('batches')).filter((d) => d.dir).map((d) => d.name)
      .sort().reverse();
    const batches = await Promise.all(names.map(async (name) => ({
      name, info: await readJson(`batches/${name}/batch.json`),
      statuses: await loadStatuses(name) })));
    list.innerHTML = '';
    if (!batches.length) {
      list.innerHTML = '<div class="empty">No batches yet. Export one on the workstation ' +
        '(D_label_repair notebook, section EXPORT FOR iPAD).</div>';
    }
    for (const b of batches) list.appendChild(batchCard(b));
  } catch (e) {
    list.innerHTML = `<div class="empty">Could not read the batches: ${esc(e.message)}</div>`;
  }
  updateOutbox();
}

function counts(b) {
  const states = Object.values(b.statuses).map((s) => s.state);
  return { total: b.info.crops.length, done: states.filter((s) => s === 'done').length,
           skipped: states.filter((s) => s === 'skipped').length };
}

function batchCard(b) {
  const c = counts(b);
  const when = new Date(b.info.created);
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="name">${esc(String(b.info.source).replace(/ \([a-z0-9]+\)$/, ''))}</div>
    <div class="meta">exported ${when.toLocaleDateString()} ${when.toLocaleTimeString([],
      { hour: '2-digit', minute: '2-digit' })} on ${esc(b.info.host)}</div>
    <div class="meta">${c.done} done, ${c.skipped} skipped, ${c.total - c.done - c.skipped}
      to repair of ${c.total} crops</div>
    <div class="meter"><span class="done" style="width:${100 * c.done / c.total}%"></span>
      <span class="skipped" style="width:${100 * c.skipped / c.total}%"></span></div>`;
  el.onclick = () => openBatch(b);
  return el;
}

function openBatch(b) {
  state.batchName = b.name;
  state.batch = b.info;
  state.statuses = b.statuses;
  const first = b.info.crops.findIndex((w) => !b.statuses[w.name]);
  show('editor');
  openWindow(first >= 0 ? first : 0);
}

$('btn-refresh').onclick = () => { ensureSignedIn().then(showBatches).catch((e) => msg(e.message)); };
$('btn-back').onclick = () => {
  if (state.edits && !confirm('Leave this crop without committing your changes?')) return;
  state.edits = 0;
  ensureSignedIn().then(showBatches).catch(() => showBatches());
};

// ------------------------------------------------------------------ windows
async function openWindow(i) {
  const w = state.batch.crops[i];
  state.index = i;
  msg(`Loading ${w.name} ...`);
  const base = `batches/${state.batchName}/crops/${w.name}`;
  let img, masks;
  try {
    [img, masks] = await Promise.all([store.read(`${base}_img.tif`),
                                      store.read(`${base}_masks.tif`)]);
  } catch (e) {
    msg(`Could not load ${w.name}: ${e.message}`, true);
    return;
  }
  if (state.session) state.session.destroy();
  state.session = new Session(img, masks, w, state.batch);
  const info = state.session.info;
  state.label = info.primary;
  state.z = info.primary_z.length ? info.primary_z[info.primary_z.length >> 1] : 0;
  state.pending = null;
  state.edits = 0;
  $('z').max = String(info.shape[0] - 1);
  plane.width = info.shape[2];
  plane.height = info.shape[1];
  planeImage = pctx.createImageData(plane.width, plane.height);
  updateTitle();
  fit();
  loadPlane();
  setLabel(state.label);
  const done = state.statuses[w.name];
  msg(done ? `Already ${done.state}${done.crops ? `: ${done.crops.join(', ')}` : ''}`
           : `Mask ${info.primary} with ${w.connected_labels.length} touching; ` +
             `${info.shape[0]} planes`);
}

function updateTitle() {
  const w = state.batch.crops[state.index];
  const c = counts({ info: state.batch, statuses: state.statuses });
  $('title').textContent = `${w.name}`;
  $('progress-badge').textContent = `${state.index + 1} / ${c.total}  -  ${c.done} done`;
  $('btn-prev').disabled = state.index === 0;
  $('btn-next').disabled = state.index >= c.total - 1;
  const s = state.statuses[w.name];
  $('btn-commit').textContent = s && s.state === 'done' ? 'Commit again' : 'Commit';
}

function leaveWindow(to) {
  if (state.edits && !confirm('Discard the changes to this crop?')) return;
  openWindow(to);
}

function nextOpen(after) {
  const crops = state.batch.crops;
  for (let k = 1; k <= crops.length; k++) {
    const i = (after + k) % crops.length;
    if (!state.statuses[crops[i].name]) return i;
  }
  return -1;
}

$('btn-prev').onclick = () => leaveWindow(state.index - 1);
$('btn-next').onclick = () => leaveWindow(state.index + 1);
$('btn-windows').onclick = () => {
  const list = $('window-list');
  list.innerHTML = '';
  state.batch.crops.forEach((w, i) => {
    const s = state.statuses[w.name];
    const row = document.createElement('div');
    row.className = `window-row${i === state.index ? ' current' : ''}`;
    row.innerHTML = `<span>${esc(w.name)}</span>` +
      `<span class="state ${s ? s.state : ''}">${s ? s.state : 'to repair'}</span>`;
    row.onclick = () => { $('window-drawer').hidden = true; leaveWindow(i); };
    list.appendChild(row);
  });
  $('window-drawer').hidden = false;
};
$('btn-close-drawer').onclick = () => { $('window-drawer').hidden = true; };

// ------------------------------------------------------------------ commit / skip
async function finish(status, files, note) {
  const w = state.batch.crops[state.index];
  const base = `batches/${state.batchName}`;
  await outbox.add({ files: [
    ...files.map((f) => ({ path: `${base}/repaired/${f.name}`, bytes: f.bytes, mime: f.mime })),
    { path: `${base}/status/${w.name}.json`, bytes: encode(status), mime: 'application/json' }] });
  state.statuses[w.name] = status;
  state.edits = 0;
  const left = await outbox.flush(store);
  updateOutbox(left);
  const next = nextOpen(state.index);
  if (next < 0) {
    msg(`${note}. All crops of this batch are done.`);
    updateTitle();
    return;
  }
  await openWindow(next);
  msg(left ? `${note} - waiting to upload` : note);
}

$('btn-commit').onclick = () => {
  const signing = ensureSignedIn();
  if (!state.edits && !confirm('Nothing was changed. Commit this crop as correct?')) return;
  signing.then(() => {
    const prev = state.statuses[state.batch.crops[state.index].name];
    const { record, files } = state.session.commit(device());
    const status = { state: 'done', time: new Date().toISOString(), device: device(),
                     crops: [...((prev && prev.crops) || []), record.name],
                     bounds_zyx: record.meta.bounds_zyx };
    return finish(status, files, `Committed ${record.name}`);
  }).catch((e) => msg(`Commit failed: ${e.message}`, true));
};

$('btn-skip').onclick = () => {
  const signing = ensureSignedIn();
  signing.then(() => finish({ state: 'skipped', time: new Date().toISOString(),
                              device: device() }, [], 'Skipped'))
    .catch((e) => msg(`Skip failed: ${e.message}`, true));
};

async function updateOutbox(n) {
  const left = n === undefined ? await outbox.count() : n;
  for (const id of ['outbox', 'outbox-batches']) {
    $(id).hidden = !left;
    $(id).textContent = `${left} waiting to upload - tap to retry`;
  }
}
for (const id of ['outbox', 'outbox-batches']) {
  $(id).onclick = () => {
    ensureSignedIn().then(() => outbox.flush(store)).then(updateOutbox)
      .catch((e) => msg(e.message, true));
  };
}
window.addEventListener('online', () => {
  if (store.signedIn) outbox.flush(store).then(updateOutbox);
});

// ------------------------------------------------------------------ drawing
function color(id) {
  let c = colors.get(id);
  if (!c) {
    // golden-ratio hues: neighbouring label IDs get distinct colours (HSL 85%, 55%)
    const h = (id * 0.6180339887) % 1;
    const f = (n) => {
      const k = (n + h * 12) % 12;
      return Math.round(255 * (0.55 - 0.38 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    c = [f(0), f(8), f(4)];
    colors.set(id, c);
  }
  return c;
}

function compose() {
  const { img, lab } = state;
  const nx = state.session.nx;
  const ny = state.session.ny;
  const [lo, hi0] = state.session.info.display;
  const hi = lo + (hi0 - lo) * Math.pow(2, -state.contrast / 50);
  const k = 255 / Math.max(hi - lo, 1e-6);
  const d = planeImage.data;
  for (let y = 0, i = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++, i++) {
      let g = (img[i] - lo) * k;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      let r = g, gg = g, b = g;
      const id = lab[i];
      if (id) {
        const edge = (x > 0 && lab[i - 1] !== id) || (x < nx - 1 && lab[i + 1] !== id) ||
                     (y > 0 && lab[i - nx] !== id) || (y < ny - 1 && lab[i + nx] !== id);
        const sel = id === state.label;
        const a = edge ? (sel ? 1 : 0.8)
                       : state.outline ? 0 : Math.min(1, state.opacity + (sel ? 0.15 : 0));
        const c = color(id);
        r = r * (1 - a) + c[0] * a;
        gg = gg * (1 - a) + c[1] * a;
        b = b * (1 - a) + c[2] * a;
      }
      const o = i * 4;
      d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  pctx.putImageData(planeImage, 0, 0);
}

let frame = 0;
function render(recompose = true) {
  if (recompose) render.compose = true;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (render.compose && state.session) compose();
    render.compose = false;
    draw();
  });
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!state.session) return;
  const v = state.view;
  ctx.setTransform(v.s * dpr, 0, 0, v.s * dpr, v.x * dpr, v.y * dpr);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(plane, 0, 0);
  ctx.lineWidth = 2 / v.s;
  if (state.stroke && state.tool === 'cut') {
    ctx.strokeStyle = '#ffd34d';
    ctx.beginPath();
    state.stroke.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
  if (state.pending && state.pending.z === state.z) {
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(state.pending.p.x, state.pending.p.y, 6 / v.s + 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (state.hover && ['paint', 'erase'].includes(state.tool)) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.arc(state.hover.x, state.hover.y, Math.max(0.5, state.brush / 2), 0, Math.PI * 2);
    ctx.stroke();
  }
}

function fit() {
  const s = state.session;
  if (!s) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const scale = Math.min(w / s.nx, h / s.ny) * 0.94;
  state.view = { s: scale, x: (w - s.nx * scale) / 2, y: (h - s.ny * scale) / 2 };
  render(false);
}

function loadPlane() {
  state.img = state.session.imagePlane(state.z);
  state.lab = state.session.labelPlane(state.z);
  $('z').value = String(state.z);
  $('z-label').textContent = `z ${state.z + 1} / ${state.session.nz}`;
  render();
}

function setZ(z) {
  if (!state.session || state.stroke) return;
  const clamped = Math.max(0, Math.min(state.session.nz - 1, z));
  if (clamped === state.z) return;
  state.z = clamped;
  loadPlane();
}

function setLabel(id) {
  state.label = id;
  $('label-id').textContent = String(id);
  const c = color(id);
  $('swatch').style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
  render();
}

// ------------------------------------------------------------------ tools UI
function buildTools() {
  const nav = $('tools');
  for (const t of TOOLS) {
    if (!t) { nav.appendChild(document.createElement('hr')); continue; }
    const [id, label, kind] = t;
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.tool = id;
    b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[id]}</svg><span>${label}</span>`;
    b.onclick = () => (kind === 'action' ? action(id) : selectTool(id));
    nav.appendChild(b);
  }
  selectTool('paint', true);
}

function selectTool(id, quiet = false) {
  state.tool = id;
  state.pending = null;
  for (const b of document.querySelectorAll('.tool')) {
    b.classList.toggle('active', b.dataset.tool === id);
  }
  if (!quiet && HINTS[id]) msg(HINTS[id]);
  render(false);
}

function action(id) {
  if (!state.session) return;
  if (id === 'new') {
    setLabel(state.session.nextLabel());
    selectTool('paint', true);
    msg(`New label ${state.label}: paint it`);
  } else if (id === 'undo') {
    if (state.session.undo()) {
      state.edits = Math.max(0, state.edits - 1);
      loadPlane();
      msg('Undone');
    } else msg('Nothing to undo');
  }
}

function runOp(op, points) {
  msg('Working ...');
  setTimeout(() => {                    // let the message paint before Python runs
    const r = state.session.run(op, points);
    if (r.ok) state.edits += 1;
    loadPlane();
    msg(r.msg || (r.ok ? 'Done' : 'Nothing changed'), !r.ok);
  }, 20);
}

// ------------------------------------------------------------------ tool actions
const inside = (p) => p.x >= 0 && p.y >= 0 && p.x < state.session.nx && p.y < state.session.ny;

function stamp(a, b) {
  const nx = state.session.nx;
  const ny = state.session.ny;
  const r = Math.max(0.5, state.brush / 2);
  const value = state.tool === 'erase' ? 0 : state.label;
  const lab = state.lab;
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(0.5, r / 2)));
  for (let s = 0; s <= steps; s++) {
    const cx = a.x + ((b.x - a.x) * s) / steps;
    const cy = a.y + ((b.y - a.y) * s) / steps;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(ny - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(nx - 1, Math.ceil(cx + r)); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > r * r) continue;
        const i = y * nx + x;
        if (state.protect && value && lab[i] && lab[i] !== value) continue;
        lab[i] = value;
      }
    }
  }
}

function toolDown(p) {
  const t = state.tool;
  if (t === 'paint' || t === 'erase') {
    if (t === 'paint' && !state.label) { msg('Pick a mask or tap New first', true); return; }
    state.stroke = { pts: [p], last: p };
    stamp(p, p);
    render();
    return;
  }
  if (t === 'cut') { state.stroke = { pts: [p] }; render(false); return; }
  if (!inside(p)) return;
  const y = Math.floor(p.y);
  const x = Math.floor(p.x);
  const id = state.lab[y * state.session.nx + x];
  if (t === 'pick') {
    if (id) { setLabel(id); selectTool('paint', true); msg(`Painting with label ${id}`); }
    return;
  }
  if (!id) { msg('Tap on a mask', true); return; }
  if (t === 'merge2d' || t === 'merge3d') {
    if (!state.pending) {
      state.pending = { p, z: state.z, y, x, id };
      msg(`Keeping ${id}: now tap the mask to merge into it`);
      render(false);
      return;
    }
    const a = state.pending;
    state.pending = null;
    runOp(t, [[a.z, a.y, a.x], [state.z, y, x]]);
    return;
  }
  runOp(t, [[state.z, y, x]]);
}

function toolMove(p) {
  const s = state.stroke;
  if (!s) return;
  if (state.tool === 'cut') { s.pts.push(p); render(false); return; }
  stamp(s.last, p);
  s.last = p;
  render();
}

function toolUp() {
  const s = state.stroke;
  state.stroke = null;
  if (!s) return;
  if (state.tool === 'cut') {
    const pts = simplify(s.pts, 1.0);
    if (pts.length < 2) { render(false); return; }
    runOp('cut', pts.map((q) => [state.z, q.y, q.x]));
    return;
  }
  const r = state.session.setPlane(state.z, state.lab);
  if (r.edited.length) state.edits += 1;
  state.lab = state.session.labelPlane(state.z);
  render();
}

// Ramer-Douglas-Peucker: a drawn cut becomes a few points
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
  let far = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((b.y - a.y) * pts[i].x - (b.x - a.x) * pts[i].y + b.x * a.y - b.y * a.x) / len;
    if (d > far) { far = d; idx = i; }
  }
  if (far <= eps) return [a, b];
  return simplify(pts.slice(0, idx + 1), eps).slice(0, -1).concat(simplify(pts.slice(idx), eps));
}

// ------------------------------------------------------------------ pointer input
const touches = new Map();
let gesture = null;
let penId = null;
let lastTap = 0;

function toImage(e) {
  const r = canvas.getBoundingClientRect();
  const v = state.view;
  return { x: (e.clientX - r.left - v.x) / v.s, y: (e.clientY - r.top - v.y) / v.s };
}

function startGesture() {
  const pts = [...touches.values()];
  gesture = pts.length ? { pts: pts.map((p) => ({ ...p })), view: { ...state.view },
                           moved: false, t: performance.now() } : null;
}

function moveGesture() {
  if (!gesture) return;
  const pts = [...touches.values()];
  const g = gesture;
  if (pts.length === 1 && g.pts.length === 1) {
    const dx = pts[0].x - g.pts[0].x;
    const dy = pts[0].y - g.pts[0].y;
    if (Math.hypot(dx, dy) > 4) g.moved = true;
    state.view.x = g.view.x + dx;
    state.view.y = g.view.y + dy;
  } else if (pts.length >= 2 && g.pts.length >= 2) {
    g.moved = true;
    const d0 = Math.hypot(g.pts[1].x - g.pts[0].x, g.pts[1].y - g.pts[0].y) || 1;
    const d1 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
    const m0 = { x: (g.pts[0].x + g.pts[1].x) / 2, y: (g.pts[0].y + g.pts[1].y) / 2 };
    const m1 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const s = Math.max(0.3, Math.min(60, (g.view.s * d1) / d0));
    const ix = (m0.x - g.view.x) / g.view.s;
    const iy = (m0.y - g.view.y) / g.view.s;
    state.view = { s, x: m1.x - ix * s, y: m1.y - iy * s };
  }
  render(false);
}

function local(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state.session) return;
  e.preventDefault();
  const fingerTool = e.pointerType === 'touch' && state.finger && touches.size === 0 && penId === null;
  if (e.pointerType === 'touch' && !fingerTool) {
    if (penId !== null && !state.finger) return;          // palm while the Pencil draws
    if (penId !== null) { state.stroke = null; penId = null; loadPlane(); }  // second finger
    canvas.setPointerCapture(e.pointerId);
    touches.set(e.pointerId, local(e));
    startGesture();
    return;
  }
  if (penId !== null) return;
  penId = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  toolDown(toImage(e));
});

canvas.addEventListener('pointermove', (e) => {
  if (touches.has(e.pointerId)) { touches.set(e.pointerId, local(e)); moveGesture(); return; }
  const p = toImage(e);
  if (e.pointerId === penId) { toolMove(p); return; }
  if (e.pointerType !== 'touch') { state.hover = p; render(false); }   // Pencil hover, mouse
});

function pointerEnd(e) {
  if (touches.has(e.pointerId)) {
    touches.delete(e.pointerId);
    const tap = gesture && !gesture.moved && performance.now() - gesture.t < 250;
    if (tap && touches.size === 0) {
      const now = performance.now();
      if (now - lastTap < 350) fit();                    // double tap: fit
      lastTap = now;
    }
    startGesture();
    return;
  }
  if (e.pointerId === penId) {
    penId = null;
    toolUp();
  }
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);
canvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'touch' && e.pointerId !== penId) { state.hover = null; render(false); }
});
canvas.addEventListener('wheel', (e) => {             // mouse / trackpad zoom
  e.preventDefault();
  const m = local(e);
  const v = state.view;
  const s = Math.max(0.3, Math.min(60, v.s * Math.exp(-e.deltaY / 400)));
  state.view = { s, x: m.x - ((m.x - v.x) * s) / v.s, y: m.y - ((m.y - v.y) * s) / v.s };
  render(false);
}, { passive: false });
for (const ev of ['gesturestart', 'gesturechange']) {
  document.addEventListener(ev, (e) => e.preventDefault());   // no page zoom in Safari
}

// ------------------------------------------------------------------ controls
$('z').oninput = (e) => setZ(Number(e.target.value));
$('btn-zup').onclick = () => setZ(state.z + 1);
$('btn-zdown').onclick = () => setZ(state.z - 1);
$('brush').oninput = (e) => {
  state.brush = Number(e.target.value);
  $('brush-value').textContent = String(state.brush);
  render(false);
};
$('opacity').oninput = (e) => { state.opacity = Number(e.target.value) / 100; render(); };
$('contrast').oninput = (e) => { state.contrast = Number(e.target.value); render(); };
$('outline').onchange = (e) => { state.outline = e.target.checked; render(); };
$('protect').onchange = (e) => { state.protect = e.target.checked; };
$('finger').onchange = (e) => { state.finger = e.target.checked; };
$('btn-fit').onclick = fit;
// refit when the stage changes size (rotation, split view) -- after layout,
// which the window's resize event precedes
new ResizeObserver(() => fit()).observe(canvas);
document.addEventListener('keydown', (e) => {
  if (!state.session || $('editor').hidden) return;
  if (e.key === 'w' || e.key === 'ArrowUp') setZ(state.z + 1);
  else if (e.key === 'q' || e.key === 'ArrowDown') setZ(state.z - 1);
  else if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); action('undo'); }
});

// test hook (Playwright): read-only view of the state
window.nucleiRepair = { state, store };

main();
