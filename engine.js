// ipad_repair/engine.js
// Python in the browser: Pyodide with numpy, scipy and scikit-image runs the
// workstation's repair code (py/label_repair.py) through py/repair_core.py.

import { CONFIG } from './config.js';

const TIFFFILE = 'vendor/tifffile-2026.9.20-py3-none-any.whl';
let py = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

// Typed copy of a numpy array returned by Python (frees the proxy).
function take(proxy) {
  const buf = proxy.getBuffer();
  const out = buf.data.slice();
  buf.release();
  proxy.destroy();
  return out;
}

export async function startEngine(progress = () => {}) {
  progress('Loading Python');
  await loadScript(`${CONFIG.pyodide}pyodide.js`);
  py = await loadPyodide({ indexURL: CONFIG.pyodide });
  progress('Loading numpy and scipy');
  await py.loadPackage(['numpy', 'scipy', 'packaging', 'lazy_loader', 'micropip']);
  // scikit-image alone: its declared dependencies pull in matplotlib, which
  // the repair code never imports
  progress('Loading scikit-image');
  const lock = await (await fetch(`${CONFIG.pyodide}pyodide-lock.json`)).json();
  const skimage = CONFIG.pyodide + lock.packages['scikit-image'].file_name;
  const micropip = py.pyimport('micropip');
  await micropip.install.callKwargs([skimage, new URL(TIFFFILE, location.href).href],
                                    { deps: false });
  micropip.destroy();
  progress('Loading the repair code');
  for (const name of ['label_repair.py', 'repair_core.py']) {
    const text = await (await fetch(`py/${name}?v=${CONFIG.version}`)).text();
    py.FS.writeFile(`/home/pyodide/${name}`, text);
  }
  py.runPython('import repair_core');
  return py;
}

// One crop window being repaired (wraps repair_core.Session).
export class Session {
  constructor(imgBytes, masksBytes, window, batch) {
    py.FS.writeFile('/tmp/w_img.tif', imgBytes);
    py.FS.writeFile('/tmp/w_masks.tif', masksBytes);
    const Cls = py.pyimport('repair_core').Session;
    this.s = Cls('/tmp/w_img.tif', '/tmp/w_masks.tif', JSON.stringify(window),
                 JSON.stringify(batch));
    this.info = JSON.parse(this.s.info());
    [this.nz, this.ny, this.nx] = this.info.shape;
  }

  imagePlane(z) { return take(this.s.image_plane(z)); }
  labelPlane(z) { return take(this.s.label_plane(z)); }
  labelAt(z, y, x) { return this.s.label_at(z, y, x); }
  nextLabel() { return this.s.next_label(); }
  setPlane(z, plane) { return JSON.parse(this.s.set_plane(z, plane)); }
  run(op, points) { return JSON.parse(this.s.run(op, JSON.stringify(points))); }
  undo() { return this.s.undo(); }
  commitBounds() { return this.s.commit_bounds().toJs(); }
  changed() { return this.s.changed(); }
  rebase() { this.s.rebase(); }

  // Continue from an earlier commit of this window (its masks file's bytes).
  applyCommit(masksBytes, bounds, name) {
    py.FS.writeFile('/tmp/prior_masks.tif', masksBytes);
    this.s.apply_commit('/tmp/prior_masks.tif', py.toPy(bounds), name);
  }

  // Draft of the uncommitted edits: {labels: Int32Array, state: JSON}.
  snapshot() {
    const pair = this.s.snapshot();
    const labels = take(pair.get(0));
    const state = pair.get(1);
    pair.destroy();
    return { labels, state };
  }

  restore(draft) { this.s.restore(draft.labels, draft.state); }

  // Files of the committed crop: [{name, bytes, mime}], and the record.
  commit(device) {
    const out = '/tmp/commit';
    const record = JSON.parse(this.s.commit(out, device, ''));
    const files = record.files.map((name) => ({
      name, bytes: py.FS.readFile(`${out}/${name}`),
      mime: name.endsWith('.json') ? 'application/json' : 'image/tiff' }));
    for (const f of record.files) py.FS.unlink(`${out}/${f}`);
    return { record, files };
  }

  destroy() { this.s.destroy(); }
}
