"""
ipad_repair/py/repair_core.py
Repair session for one crop window, run by the iPad app in Pyodide (and
testable in CPython).

The app keeps one :class:`Session`.  It reads planes for display, paints into
a plane and hands it back, and runs the repair operations of
``label_repair.py`` -- the workstation's code, unchanged.  Commit cuts the
repaired crop in the training format: the whole window in XY, the Z extent of
the edited labels and of the window's primary label, with the same sidecar
the workstation's repair widget writes.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, List, Sequence

import numpy as np
import tifffile

import label_repair as lr

HISTORY = 20                      # undo steps kept


def _flat(array: np.ndarray, dtype) -> np.ndarray:
    return np.ascontiguousarray(array, dtype=dtype).ravel()


def _as_array(plane: Any, dtype, shape: Sequence[int]) -> np.ndarray:
    """A plane handed over by the app (JS typed array in Pyodide) or by a test."""
    if hasattr(plane, 'to_py'):                  # JsProxy of a typed array
        plane = plane.to_py()
    if isinstance(plane, np.ndarray):
        return plane.astype(dtype).reshape(shape)
    return np.frombuffer(memoryview(plane), dtype=dtype).reshape(shape).copy()


class Session:
    """One crop window being repaired.

    Parameters
    ----------
    img_path, masks_path : str or Path
        The window's ``_img.tif`` / ``_masks.tif`` from the batch.
    window, batch : dict or JSON str
        The window's entry of ``batch.json`` and the batch itself.
    """

    OPS = {
        'merge2d': ('merge_labels_2d', 2), 'merge3d': ('merge_labels_3d', 2),
        'delete2d': ('delete_label', 1), 'delete3d': ('delete_label_3d', 1),
        'relabel': ('relabel_slice', 1), 'cut': ('reslice_label', -1),
    }

    def __init__(self, img_path, masks_path, window, batch) -> None:
        self.window = json.loads(window) if isinstance(window, str) else dict(window)
        self.batch = json.loads(batch) if isinstance(batch, str) else dict(batch)
        self.image = tifffile.imread(str(img_path))
        masks = tifffile.imread(str(masks_path))
        self.mask_dtype = masks.dtype
        self.labels = masks.astype(np.int32)
        if self.image.shape != self.labels.shape:
            raise ValueError(f'image {self.image.shape} and masks {self.labels.shape} differ')
        self.primary = int(self.window['primary_label'])
        self.edited: set = set()
        self.edited_z: set = set()
        self.history: List[np.ndarray] = []
        self.base = self.labels.copy()       # what "unchanged" means (see apply_commit)
        self.prior = None                    # commit this session continues from

    def apply_commit(self, masks_path, bounds: Sequence[int], name: str) -> None:
        """Continue from an earlier commit of this window: its masks replace the
        window's within its bounds.  Committing again replaces that crop (same
        name, files overwritten) and covers at least its planes."""
        z0, z1, y0, y1, x0, x1 = (int(v) for v in bounds)
        self.labels[z0:z1, y0:y1, x0:x1] = tifffile.imread(str(masks_path)).astype(np.int32)
        self.base = self.labels.copy()
        self.history.clear()
        self.prior = str(name)
        self.edited_z |= set(range(z0, z1))

    def changed(self) -> bool:
        """Whether the masks differ from where this session started."""
        return not np.array_equal(self.labels, self.base)

    def snapshot(self):
        """Draft of the edits: the masks (int32, flat) and the edit record (JSON)."""
        state = {'edited': sorted(int(i) for i in self.edited),
                 'edited_z': sorted(int(z) for z in self.edited_z), 'prior': self.prior}
        return _flat(self.labels, np.int32), json.dumps(state)

    def restore(self, labels: Any, state: str) -> None:
        """Pick up a draft saved by :meth:`snapshot`."""
        self.labels = _as_array(labels, np.int32, self.labels.shape)
        s = json.loads(state)
        self.edited = set(s['edited'])
        self.edited_z = set(s['edited_z'])
        self.history.clear()

    # ------------------------------------------------------------ reading
    def info(self) -> str:
        """Shape, display range and label numbers, as JSON.  The display range
        is the dataset's tissue range -- what Cellpose sees as 0..1 -- else the
        window's 0.5-99.8th percentiles."""
        display = self.batch.get('source_range')
        if not display or display[1] <= display[0]:
            lo, hi = (float(v) for v in np.percentile(self.image, [0.5, 99.8]))
            display = [lo, hi if hi > lo else lo + 1.0]
        return json.dumps({
            'shape': list(self.image.shape), 'dtype': str(self.image.dtype),
            'display': [float(v) for v in display],
            'primary': self.primary, 'next_label': self.next_label(),
            'n_labels': int(len(np.unique(self.labels)) - 1),
            'primary_z': [int(z) for z in np.where((self.labels == self.primary)
                                                   .any(axis=(1, 2)))[0]],
        })

    def image_plane(self, z: int) -> np.ndarray:
        return _flat(self.image[int(z)], np.float32)

    def label_plane(self, z: int) -> np.ndarray:
        return _flat(self.labels[int(z)], np.int32)

    def label_at(self, z: int, y: int, x: int) -> int:
        return int(self.labels[int(z), int(y), int(x)])

    def next_label(self) -> int:
        return int(self.labels.max(initial=0)) + 1

    # ------------------------------------------------------------ editing
    def _record(self, before: np.ndarray) -> List[int]:
        """Push *before* to the undo history and note what changed."""
        changed = before != self.labels
        if not changed.any():
            return []
        self.history.append(before)
        del self.history[:-HISTORY]
        ids = (set(np.unique(before[changed]).tolist())
               | set(np.unique(self.labels[changed]).tolist())) - {0}
        self.edited |= ids
        self.edited_z |= set(np.where(changed.any(axis=(1, 2)))[0].tolist())
        return sorted(int(i) for i in ids)

    def set_plane(self, z: int, plane: Any) -> str:
        """Replace plane *z* by the app's painted version."""
        before = self.labels.copy()
        self.labels[int(z)] = _as_array(plane, np.int32, self.labels.shape[1:])
        return json.dumps({'ok': True, 'edited': self._record(before)})

    def run(self, op: str, points: Any) -> str:
        """Run a repair operation; *points* are ``[[z, y, x], ...]`` voxels."""
        if hasattr(points, 'to_py'):
            points = points.to_py()
        if isinstance(points, str):
            points = json.loads(points)
        name, n_points = self.OPS[op]
        pts = [tuple(int(round(v)) for v in p) for p in points]
        if n_points > 0 and len(pts) != n_points:
            return json.dumps({'ok': False, 'msg': f'{op} needs {n_points} point(s)'})
        if op == 'cut':
            pts = self._from_entry(pts)
            if len(pts) < 2:
                return json.dumps({'ok': False, 'msg': 'draw the cut across a mask'})
        fn = getattr(lr, name)
        before = self.labels.copy()
        if op == 'cut':
            result = fn(self.labels, self.image, pts, inplace=False)
        elif n_points == 2:
            result = fn(self.labels, pts[0], pts[1], inplace=False)
        else:
            result = fn(self.labels, pts[0], inplace=False)
        new_labels, ok, msg = result[0], result[1], result[2]
        if ok:
            self.labels = np.asarray(new_labels, dtype=np.int32)
        edited = self._record(before) if ok else []
        return json.dumps({'ok': bool(ok), 'msg': str(msg), 'edited': edited})

    def _from_entry(self, pts: List[tuple]) -> List[tuple]:
        """The stroke from where it first enters a mask.

        A cut is drawn across a mask, so it starts outside one -- but the cut
        takes its label from its first point.  The stroke is walked in 1-voxel
        steps; it then starts at its entry into a mask and goes on through the
        remaining points (the side test extends the end segments, so the cut
        through the mask is unchanged)."""
        for i in range(len(pts) - 1):
            (z, y0, x0), (_, y1, x1) = pts[i], pts[i + 1]
            steps = max(1, int(np.ceil(np.hypot(y1 - y0, x1 - x0))))
            for t in np.linspace(0.0, 1.0, steps + 1):
                y, x = int(round(y0 + t * (y1 - y0))), int(round(x0 + t * (x1 - x0)))
                inside = (0 <= y < self.labels.shape[1] and 0 <= x < self.labels.shape[2]
                          and self.labels[z, y, x] != 0)
                if inside:
                    rest = [p for p in pts[i + 1:] if p[1:] != (y, x)]
                    return [(z, y, x)] + rest
        return []

    def undo(self) -> bool:
        if not self.history:
            return False
        self.labels = self.history.pop()
        return True

    # ------------------------------------------------------------ commit
    def commit_bounds(self) -> List[int]:
        """Window-relative bounds of the crop to commit: XY the whole window,
        Z the planes of the edited labels and the primary label."""
        keep = np.isin(self.labels, sorted(self.edited | {self.primary}))
        zs = set(np.where(keep.any(axis=(1, 2)))[0].tolist()) | self.edited_z
        if not zs:
            zs = set(range(self.labels.shape[0]))
        _, ny, nx = self.labels.shape
        return [min(zs), max(zs) + 1, 0, ny, 0, nx]

    def commit(self, out_dir, device: str = 'iPad', now: str = '') -> str:
        """Write ``<name>_img.tif``, ``_masks.tif`` and ``_meta.json`` into
        *out_dir*; returns ``{name, files, meta}`` as JSON."""
        when = datetime.fromisoformat(now) if now else datetime.now()
        z0, z1, y0, y1, x0, x1 = self.commit_bounds()
        img = self.image[z0:z1, y0:y1, x0:x1]
        masks = self.labels[z0:z1, y0:y1, x0:x1]
        mask_dtype = (np.uint16 if int(masks.max(initial=0)) <= np.iinfo(np.uint16).max
                      else np.uint32)
        present = set(np.unique(masks).tolist())
        edited = sorted(i for i in self.edited if i in present)   # not painted-then-erased
        ids = [self.primary] + [i for i in edited if i != self.primary]
        created = when
        if self.prior:                       # committed before: the same crop, replaced
            name = self.prior
            try:
                _, day, clock = name.split('_')[:3]
                created = datetime.strptime(day + clock, '%Y%m%d%H%M%S')
            except ValueError:
                pass
        else:
            name = f"repair_{when:%Y%m%d_%H%M%S}_{'_'.join(str(i) for i in ids[:3])}"
        wz, _, wy, _, wx, _ = self.window['window_zyx']
        bounds = [z0, z1, y0, y1, x0, x1]
        origin = [wz, wz, wy, wy, wx, wx]
        meta = {
            'source': self.batch.get('source'), 'source_path': self.batch.get('source_path'),
            'dtype': str(img.dtype), 'shape_zyx': list(img.shape),
            'bounds_zyx': bounds,
            'volume_bounds_zyx': [int(b) + int(o) for b, o in zip(bounds, origin)],
            'host': device,
            'percentiles_1_50_99': [float(v) for v in
                                    np.percentile(img.astype(np.float32), [1, 50, 99])],
            'volume_lowhigh': self.batch.get('source_range'),
            'created': created.isoformat(timespec='seconds'),
            'updated': when.isoformat(timespec='seconds'),
            'batch': self.batch.get('name'), 'window': self.window['name'],
            'edited_labels': [int(i) for i in edited],
        }
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        files = [f'{name}_img.tif', f'{name}_masks.tif', f'{name}_meta.json']
        tifffile.imwrite(out / files[0], img, photometric='minisblack')
        tifffile.imwrite(out / files[1], masks.astype(mask_dtype), photometric='minisblack')
        (out / files[2]).write_text(json.dumps(meta, indent=2), encoding='utf-8')
        # the committed state is the new start; committing again replaces this crop
        self.prior = name
        self.rebase()
        return json.dumps({'name': name, 'files': files, 'meta': meta})

    def rebase(self) -> None:
        """Take the current masks as the start (after a commit, or a skip):
        nothing is unsaved any more."""
        self.base = self.labels.copy()
        self.history.clear()
