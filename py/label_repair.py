"""Label repair operations with user-guided points.

Operations:
1. Reslice: Cut a label along a user-drawn line, propagated through Z
2. Split: Split 1 label into 2 using watershed from 2 seed points (spherical seeds)
3. Merge 2D: Merge label B into A in one slice only
4. Merge 3D: Merge label B into A entirely
5. Segment: Create new label from seed point using watershed
6. Delete: Remove entire label (set to background)
7. Re-label: Assign new label to region in current slice only (for Z-slice separation)
"""

import numpy as np
from scipy import ndimage
from scipy.ndimage import binary_fill_holes, distance_transform_edt
from skimage.segmentation import watershed
from skimage.measure import label as cc_label
from typing import Tuple, Optional, List


def _find_label_near_point(labels: np.ndarray, z: int, y: int, x: int, radius: int = 3) -> int:
    """Find a non-zero label near the given point."""
    # First check exact location
    if labels[z, y, x] != 0:
        return labels[z, y, x]

    # Search in small neighborhood
    for dz in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                nz, ny, nx = z + dz, y + dy, x + dx
                if (0 <= nz < labels.shape[0] and
                    0 <= ny < labels.shape[1] and
                    0 <= nx < labels.shape[2]):
                    if labels[nz, ny, nx] != 0:
                        return labels[nz, ny, nx]
    return 0


def _signed_distance_to_polyline(y: float, x: float, path_yx: np.ndarray) -> float:
    """
    Compute signed distance from point (y,x) to a polyline.

    Positive = right side of path, Negative = left side of path
    (when walking along path from first to last point)
    """
    min_dist = float('inf')
    best_sign = 1

    for i in range(len(path_yx) - 1):
        y1, x1 = path_yx[i]
        y2, x2 = path_yx[i + 1]

        # Vector from p1 to p2
        dy = y2 - y1
        dx = x2 - x1
        seg_len_sq = dy * dy + dx * dx

        if seg_len_sq < 0.0001:
            # Degenerate segment
            dist = np.sqrt((y - y1)**2 + (x - x1)**2)
            sign = 1
        else:
            # Project point onto line segment
            t = max(0, min(1, ((y - y1) * dy + (x - x1) * dx) / seg_len_sq))
            proj_y = y1 + t * dy
            proj_x = x1 + t * dx

            dist = np.sqrt((y - proj_y)**2 + (x - proj_x)**2)

            # Determine sign using cross product (right-hand rule)
            # Cross product of (dy, dx) and (y-y1, x-x1)
            cross = dy * (x - x1) - dx * (y - y1)
            sign = 1 if cross >= 0 else -1

        if dist < min_dist:
            min_dist = dist
            best_sign = sign

    return best_sign * min_dist


def reslice_label(
    labels: np.ndarray,
    image: np.ndarray,
    line_points: List[Tuple[int, int, int]],
    debug: bool = False,
    inplace: bool = False
) -> Tuple[np.ndarray, bool, str]:
    """
    Split a label along a user-defined curved path without creating gaps.

    Points define the cutting path as a polyline. The cut follows the exact
    path through all points. Pixels are assigned to different labels based
    on which side of the polyline they fall.

    Parameters
    ----------
    labels : np.ndarray
        3D label image.
    image : np.ndarray
        3D intensity image (unused, kept for API consistency).
    line_points : list
        Points [(z1, y1, x1), (z2, y2, x2), ...] defining the cut path.
        At least 2 points required. Place points along the boundary to cut.
    debug : bool
        Print debug information.
    inplace : bool
        If True, modify labels array directly instead of copying.

    Returns
    -------
    result : np.ndarray
        Updated labels with the label split into two touching labels.
    success : bool
        Whether the operation succeeded.
    message : str
        Status message.
    """
    from scipy.interpolate import interp1d

    if len(line_points) < 2:
        return (labels if inplace else labels.copy()), False, "Reslice requires at least 2 points"

    result = labels if inplace else labels.copy()

    # Convert points to arrays
    points = np.array([[round(p[0]), round(p[1]), round(p[2])] for p in line_points])

    # Get label ID from first point
    z0, y0, x0 = int(points[0, 0]), int(points[0, 1]), int(points[0, 2])
    label_id = _find_label_near_point(labels, z0, y0, x0)
    if label_id == 0:
        return result, False, "First point is not on a label"

    if debug:
        print(f"Reslice: label {label_id}, {len(points)} points")

    # Get mask of the label (from original if inplace, result is same ref)
    mask = result == label_id

    # Find Z range
    z_has_content = np.any(mask, axis=(1, 2))
    z_indices = np.where(z_has_content)[0]
    if len(z_indices) == 0:
        return result, False, f"Label {label_id} not found"

    z_min_label, z_max_label = z_indices[0], z_indices[-1]

    # Group points by Z
    z_to_points = {}
    for p in points:
        z = int(p[0])
        if z not in z_to_points:
            z_to_points[z] = []
        z_to_points[z].append([float(p[1]), float(p[2])])

    # Sort Z values that have points
    z_with_points = sorted(z_to_points.keys())

    # For interpolation between Z levels
    if len(z_with_points) >= 2:
        # Create dense path by interpolating between Z levels
        all_z = list(range(z_min_label, z_max_label + 1))

        # For each Z, we need a path (list of YX points)
        z_to_path = {}

        for z in all_z:
            if z in z_to_points:
                # Use actual points at this Z
                z_to_path[z] = np.array(z_to_points[z])
            else:
                # Interpolate from neighboring Z levels
                z_below = max([zz for zz in z_with_points if zz <= z], default=None)
                z_above = min([zz for zz in z_with_points if zz >= z], default=None)

                if z_below is None:
                    z_below = z_with_points[0]
                if z_above is None:
                    z_above = z_with_points[-1]

                if z_below == z_above:
                    z_to_path[z] = np.array(z_to_points[z_below])
                else:
                    # Linear interpolation
                    t = (z - z_below) / (z_above - z_below)
                    pts_below = np.array(z_to_points[z_below])
                    pts_above = np.array(z_to_points[z_above])

                    # Interpolate centroid
                    centroid_below = pts_below.mean(axis=0)
                    centroid_above = pts_above.mean(axis=0)
                    centroid = centroid_below + t * (centroid_above - centroid_below)

                    z_to_path[z] = np.array([centroid])
    else:
        # All points at same Z - use that path for all Z slices
        single_z = z_with_points[0]
        path = np.array(z_to_points[single_z])
        z_to_path = {z: path for z in range(z_min_label, z_max_label + 1)}

    # New label ID
    new_label = int(labels.max()) + 1

    # Process each slice
    n_side1 = 0
    n_side2 = 0

    for z in range(z_min_label, z_max_label + 1):
        slice_mask = mask[z]
        if not slice_mask.any():
            continue

        path_yx = z_to_path.get(z)
        if path_yx is None or len(path_yx) == 0:
            continue

        # If only one point, we need a direction - use global path direction
        if len(path_yx) == 1:
            # Extend using overall path direction
            dy_global = points[-1, 1] - points[0, 1]
            dx_global = points[-1, 2] - points[0, 2]
            path_len = np.sqrt(dy_global**2 + dx_global**2)
            if path_len > 0:
                dy_global /= path_len
                dx_global /= path_len
            else:
                dy_global, dx_global = 1.0, 0.0

            # Extend path in both directions
            center = path_yx[0]
            extend = max(labels.shape[1], labels.shape[2])
            path_yx = np.array([
                [center[0] - dy_global * extend, center[1] - dx_global * extend],
                [center[0] + dy_global * extend, center[1] + dx_global * extend]
            ])

        # For each pixel in the label at this Z, compute signed distance to path
        coords = np.argwhere(slice_mask)

        for coord in coords:
            py, px = coord[0], coord[1]
            signed_dist = _signed_distance_to_polyline(py, px, path_yx)

            if signed_dist < 0:
                result[z, py, px] = new_label
                n_side2 += 1
            else:
                n_side1 += 1

    if n_side1 == 0 or n_side2 == 0:
        return result, False, "Cut path does not divide the label into two parts"

    msg = f"Label {label_id}: split into {label_id} ({n_side1} vox) and {new_label} ({n_side2} vox)"
    return result, True, msg


def split_label(
    labels: np.ndarray,
    image: np.ndarray,
    seed_points: List[Tuple[int, int, int]],
    seed_radius: int = 5,
    debug: bool = False,
    inplace: bool = False
) -> Tuple[np.ndarray, bool, str]:
    """
    Split one label into two using watershed from two seed points.

    Parameters
    ----------
    labels : np.ndarray
        3D label image.
    image : np.ndarray
        3D intensity image for watershed.
    seed_points : list
        Two points [(z1, y1, x1), (z2, y2, x2)] as watershed seeds.
        Both should be in the same label.
    seed_radius : int
        Radius of seed regions (default 5). Larger seeds give more robust
        watershed propagation.
    debug : bool
        Print debug information.
    inplace : bool
        If True, modify labels array directly instead of copying.

    Returns
    -------
    result : np.ndarray
        Updated labels.
    success : bool
        Whether the operation succeeded.
    message : str
        Status message.
    """
    if len(seed_points) != 2:
        return (labels if inplace else labels.copy()), False, "Split requires exactly 2 seed points"

    result = labels if inplace else labels.copy()
    p1, p2 = seed_points
    z1, y1, x1 = int(p1[0]), int(p1[1]), int(p1[2])
    z2, y2, x2 = int(p2[0]), int(p2[1]), int(p2[2])

    # Get label ID (search nearby if needed)
    label_id = _find_label_near_point(result, z1, y1, x1)
    if label_id == 0:
        return result, False, "First seed point is not on a label"

    label_id_2 = _find_label_near_point(result, z2, y2, x2)
    if label_id_2 != label_id:
        return result, False, f"Seed points are in different labels ({label_id} vs {label_id_2})"

    if debug:
        print(f"Split: label {label_id} with seeds at ({z1},{y1},{x1}) and ({z2},{y2},{x2})")

    # Get mask for this label
    mask = result == label_id

    # Create spherical seed regions (balls) instead of single pixels
    # This ensures watershed propagates properly in 3D
    markers = np.zeros_like(labels, dtype=np.int32)

    # Create coordinate grids for distance calculation
    zz, yy, xx = np.ogrid[:labels.shape[0], :labels.shape[1], :labels.shape[2]]

    # Seed 1: ball around first point (within the label mask)
    dist_to_seed1 = np.sqrt((zz - z1)**2 + (yy - y1)**2 + (xx - x1)**2)
    seed1_region = (dist_to_seed1 <= seed_radius) & mask
    markers[seed1_region] = 1

    # Seed 2: ball around second point (within the label mask)
    dist_to_seed2 = np.sqrt((zz - z2)**2 + (yy - y2)**2 + (xx - x2)**2)
    seed2_region = (dist_to_seed2 <= seed_radius) & mask
    markers[seed2_region] = 2

    n_seed1 = seed1_region.sum()
    n_seed2 = seed2_region.sum()

    if debug:
        print(f"  Seed regions: {n_seed1} voxels (seed1), {n_seed2} voxels (seed2)")

    if n_seed1 == 0 or n_seed2 == 0:
        return result, False, "Seed points too close to label boundary"

    # Use distance transform for watershed (robust separation at narrowest point)
    dist = distance_transform_edt(mask)

    # Watershed on negative distance transform
    ws_result = watershed(-dist, markers, mask=mask)

    # Count results
    n_region1 = (ws_result == 1).sum()
    n_region2 = (ws_result == 2).sum()

    if debug:
        print(f"  Watershed result: region1={n_region1}, region2={n_region2}")

    if n_region1 == 0 or n_region2 == 0:
        return result, False, f"Label {label_id}: watershed did not produce two regions"

    # New label ID
    new_label = int(result.max()) + 1

    # Apply results: region 2 gets the new label
    region_2 = ws_result == 2
    result[region_2] = new_label

    msg = f"Split label {label_id} -> {label_id} ({n_region1} vox) + {new_label} ({n_region2} vox)"
    return result, True, msg


# Keep old name as alias for backward compatibility
def separate_label(
    labels: np.ndarray,
    image: np.ndarray,
    seed_points: List[Tuple[int, int, int]],
    debug: bool = False
) -> Tuple[np.ndarray, bool, str]:
    """Alias for split_label (backward compatibility)."""
    return split_label(labels, image, seed_points, seed_radius=5, debug=debug)


def merge_labels_2d(
    labels: np.ndarray,
    point_a: Tuple[int, int, int],
    point_b: Tuple[int, int, int],
    debug: bool = False,
    inplace: bool = False
) -> Tuple[np.ndarray, bool, str]:
    """
    Merge touching component of label B into label A in one slice only.

    Only merges the connected component of B that touches A (or is closest
    to A if no components touch). This prevents merging unrelated parts of
    label B that happen to be in the same slice.

    Parameters
    ----------
    labels : np.ndarray
        3D label image.
    point_a : tuple
        (z, y, x) point in label A (the label to keep).
    point_b : tuple
        (z, y, x) point in label B (the label to merge into A).
    debug : bool
        Print debug information.
    inplace : bool
        If True, modify labels array directly instead of copying.

    Returns
    -------
    result : np.ndarray
        Updated labels.
    success : bool
        Whether the operation succeeded.
    message : str
        Status message.
    """
    from skimage.morphology import binary_dilation, disk
    from skimage.measure import label as cc_label

    result = labels if inplace else labels.copy()
    za, ya, xa = int(point_a[0]), int(point_a[1]), int(point_a[2])
    zb, yb, xb = int(point_b[0]), int(point_b[1]), int(point_b[2])

    # Search nearby if exact location is background
    label_a = _find_label_near_point(result, za, ya, xa)
    label_b = _find_label_near_point(result, zb, yb, xb)

    if label_a == 0:
        return result, False, "Point A is not on a label"
    if label_b == 0:
        return result, False, "Point B is not on a label"
    if label_a == label_b:
        return result, False, "Points A and B are in the same label"

    # Use the Z from point A
    z_slice = za

    if debug:
        print(f"Merge 2D: label {label_b} -> {label_a} in slice {z_slice}")

    # Get masks for this slice
    slice_a_mask = result[z_slice] == label_a
    slice_b_mask = result[z_slice] == label_b

    if not slice_b_mask.any():
        return result, False, f"No voxels of label {label_b} in slice {z_slice}"

    # Find connected components of B in this slice
    b_components, n_components = cc_label(slice_b_mask, return_num=True)

    if n_components == 1:
        # Only one component - merge it all
        result[z_slice][slice_b_mask] = label_a
        n_changed = slice_b_mask.sum()
        msg = f"Merged {label_b} into {label_a} in slice {z_slice}: {n_changed} voxels"
        return result, True, msg

    # Multiple components - find which ones touch A
    # Dilate A mask by 1 pixel to find touching regions
    a_dilated = binary_dilation(slice_a_mask, disk(1))

    touching_components = []
    non_touching_components = []

    for comp_id in range(1, n_components + 1):
        comp_mask = b_components == comp_id
        # Check if this component touches A (overlaps with dilated A)
        if np.any(comp_mask & a_dilated):
            touching_components.append(comp_id)
        else:
            non_touching_components.append(comp_id)

    if debug:
        print(f"  {n_components} components of B, {len(touching_components)} touching A")

    if touching_components:
        # Merge only touching components
        merge_mask = np.zeros_like(slice_b_mask)
        for comp_id in touching_components:
            merge_mask |= (b_components == comp_id)

        n_changed = merge_mask.sum()
        result[z_slice][merge_mask] = label_a
        msg = f"Merged {len(touching_components)} touching component(s) of {label_b} into {label_a}: {n_changed} voxels"
    else:
        # No touching components - find closest one to A
        min_dist = float('inf')
        closest_comp = 1

        a_coords = np.argwhere(slice_a_mask)

        for comp_id in range(1, n_components + 1):
            comp_mask = b_components == comp_id
            comp_coords = np.argwhere(comp_mask)

            # Find minimum distance between any pixel in comp and any pixel in A
            for bc in comp_coords:
                dists = np.sqrt(((a_coords - bc) ** 2).sum(axis=1))
                d = dists.min()
                if d < min_dist:
                    min_dist = d
                    closest_comp = comp_id

        # Merge closest component
        merge_mask = b_components == closest_comp
        n_changed = merge_mask.sum()
        result[z_slice][merge_mask] = label_a
        msg = f"Merged closest component of {label_b} into {label_a} (dist={min_dist:.1f}): {n_changed} voxels"

    return result, True, msg


def merge_labels_3d(
    labels: np.ndarray,
    point_a: Tuple[int, int, int],
    point_b: Tuple[int, int, int],
    debug: bool = False,
    inplace: bool = False
) -> Tuple[np.ndarray, bool, str]:
    """
    Merge label B into label A entirely (all slices).

    Parameters
    ----------
    labels : np.ndarray
        3D label image.
    point_a : tuple
        (z, y, x) point in label A (the label to keep).
    point_b : tuple
        (z, y, x) point in label B (the label to merge into A).
    debug : bool
        Print debug information.
    inplace : bool
        If True, modify labels array directly instead of copying.

    Returns
    -------
    result : np.ndarray
        Updated labels.
    success : bool
        Whether the operation succeeded.
    message : str
        Status message.
    """
    result = labels if inplace else labels.copy()
    za, ya, xa = int(point_a[0]), int(point_a[1]), int(point_a[2])
    zb, yb, xb = int(point_b[0]), int(point_b[1]), int(point_b[2])

    # Search nearby if exact location is background
    label_a = _find_label_near_point(result, za, ya, xa)
    label_b = _find_label_near_point(result, zb, yb, xb)

    if label_a == 0:
        return result, False, "Point A is not on a label"
    if label_b == 0:
        return result, False, "Point B is not on a label"
    if label_a == label_b:
        return result, False, "Points A and B are in the same label"

    if debug:
        print(f"Merge 3D: label {label_b} -> {label_a} entirely")

    # Merge B into A everywhere
    mask_b = result == label_b
    n_changed = mask_b.sum()
    result[mask_b] = label_a

    if n_changed > 0:
        msg = f"Merged {label_b} into {label_a}: {n_changed} voxels"
        return result, True, msg
    else:
        return result, False, f"Label {label_b} not found"


def segment_from_seed(
    labels: np.ndarray,
    image: np.ndarray,
    seed_point: Tuple[int, int, int],
    estimated_diameter: int = 30,
    debug: bool = False,
    inplace: bool = False
) -> Tuple[np.ndarray, bool, str]:
    """
    Create a new label from a seed point using watershed.

    Parameters
    ----------
    labels : np.ndarray
        3D label image.
    image : np.ndarray
        3D intensity image for watershed.
    seed_point : tuple
        (z, y, x) seed point for the new label.
        Should be in an unlabeled region.
    estimated_diameter : int
        Estimated diameter of the object to segment.
    debug : bool
        Print debug information.
    inplace : bool
        If True, modify labels array directly instead of copying.

    Returns
    -------
    result : np.ndarray
        Updated labels with new label added.
    success : bool
        Whether the operation succeeded.
    message : str
        Status message.
    """
    result = labels if inplace else labels.copy()
    z, y, x = int(seed_point[0]), int(seed_point[1]), int(seed_point[2])

    # Check seed is in unlabeled region
    if result[z, y, x] != 0:
        return result, False, f"Seed point is already labeled ({result[z, y, x]})"

    if debug:
        print(f"Segment: seed at ({z},{y},{x}), diameter={estimated_diameter}")

    new_label = int(result.max()) + 1
    half_d = estimated_diameter // 2

    # Define crop region
    z_min = max(0, z - half_d // 2)
    z_max = min(result.shape[0], z + half_d // 2 + 1)
    y_min = max(0, y - half_d)
    y_max = min(result.shape[1], y + half_d + 1)
    x_min = max(0, x - half_d)
    x_max = min(result.shape[2], x + half_d + 1)

    # Get crops (views into result -- read-only use for watershed)
    crop_labels = result[z_min:z_max, y_min:y_max, x_min:x_max]
    crop_img = image[z_min:z_max, y_min:y_max, x_min:x_max].astype(float)

    # Unlabeled mask
    unlabeled_mask = crop_labels == 0

    # Local coordinates of seed
    local_z = z - z_min
    local_y = y - y_min
    local_x = x - x_min

    # Intensity-based mask
    seed_intensity = crop_img[local_z, local_y, local_x]
    threshold = seed_intensity * 0.5
    intensity_mask = crop_img > threshold

    # Valid region: unlabeled AND bright enough
    valid_mask = unlabeled_mask & intensity_mask
    if not valid_mask[local_z, local_y, local_x]:
        valid_mask = unlabeled_mask  # Fallback

    # Create markers: seed point = 1, existing labels = their ID + 1
    markers = np.zeros_like(crop_labels, dtype=int)
    markers[local_z, local_y, local_x] = 1
    for lid in np.unique(crop_labels):
        if lid > 0:
            markers[crop_labels == lid] = lid + 1

    # Watershed
    ws_result = watershed(-crop_img, markers, mask=valid_mask | (crop_labels > 0))

    # Extract new nucleus
    new_nucleus_mask = ws_result == 1
    n_voxels = new_nucleus_mask.sum()

    if n_voxels < 10:
        return result, False, "Segmented region too small (<10 voxels)"

    # Apply to result (vectorized)
    result[z_min:z_max, y_min:y_max, x_min:x_max][new_nucleus_mask] = new_label

    msg = f"Created label {new_label}: {n_voxels} voxels"
    return result, True, msg


def relabel_slice(
    labels: np.ndarray,
    point: Tuple[int, int, int],
    new_label: Optional[int] = None,
    debug: bool = False,
    inplace: bool = False
) -> Tuple[np.ndarray, bool, str, int]:
    """
    Re-label pixels of a label in a single Z slice to a new label ID.

    Useful for separating labels that are incorrectly merged across Z slices.
    Click through each slice to assign the same new label ID.

    Parameters
    ----------
    labels : np.ndarray
        3D label image.
    point : tuple
        (z, y, x) point on the label to re-label.
    new_label : int, optional
        Label ID to assign. If None, creates a new max+1 label.
    debug : bool
        Print debug information.
    inplace : bool
        If True, modify labels array directly instead of copying.

    Returns
    -------
    result : np.ndarray
        Updated labels.
    success : bool
        Whether the operation succeeded.
    message : str
        Status message.
    new_label_id : int
        The label ID that was assigned (for continuing in subsequent slices).
    """
    result = labels if inplace else labels.copy()
    z, y, x = int(point[0]), int(point[1]), int(point[2])

    # Get label ID at point
    old_label = _find_label_near_point(result, z, y, x)
    if old_label == 0:
        return result, False, "Point is not on a label", 0

    # Determine new label ID
    if new_label is None:
        new_label = int(result.max()) + 1

    # Don't re-label if it's already the target label
    if old_label == new_label:
        return result, False, f"Already label {new_label}", new_label

    if debug:
        print(f"Re-label: slice Z={z}, label {old_label} -> {new_label}")

    # Get mask of old label in this slice only
    slice_mask = result[z] == old_label
    n_pixels = slice_mask.sum()

    if n_pixels == 0:
        return result, False, f"No pixels of label {old_label} in slice Z={z}", new_label

    # Apply new label to this slice only
    result[z][slice_mask] = new_label

    msg = f"Z={z}: {old_label} -> {new_label} ({n_pixels} px)"
    return result, True, msg, new_label


def delete_label(
    labels: np.ndarray,
    point: Tuple[int, int, int],
    debug: bool = False,
    inplace: bool = False
) -> Tuple[np.ndarray, bool, str]:
    """
    Delete a label at the given point in the current slice only.

    Parameters
    ----------
    labels : np.ndarray
        3D label image.
    point : tuple
        (z, y, x) point on the label to delete.
    debug : bool
        Print debug information.
    inplace : bool
        If True, modify labels array directly instead of copying.

    Returns
    -------
    result : np.ndarray
        Updated labels with the label removed from the slice.
    success : bool
        Whether the operation succeeded.
    message : str
        Status message.
    """
    result = labels if inplace else labels.copy()
    z, y, x = int(point[0]), int(point[1]), int(point[2])

    # Get label ID (search nearby if needed)
    label_id = _find_label_near_point(result, z, y, x)
    if label_id == 0:
        return result, False, "Point is not on a label"

    if debug:
        print(f"Delete: label {label_id} at slice z={z}")

    # Count voxels in this slice before deletion
    slice_mask = result[z] == label_id
    n_voxels = slice_mask.sum()

    # Set label to background (0) only in this slice
    result[z][slice_mask] = 0

    msg = f"Deleted label {label_id} in slice {z}: {n_voxels} px removed"
    return result, True, msg


def delete_label_3d(
    labels: np.ndarray,
    point: Tuple[int, int, int],
    debug: bool = False,
    inplace: bool = False
) -> Tuple[np.ndarray, bool, str]:
    """
    Delete a label at the given point from all slices.

    Parameters
    ----------
    labels : np.ndarray
        3D label image.
    point : tuple
        (z, y, x) point on the label to delete.
    debug : bool
        Print debug information.
    inplace : bool
        If True, modify labels array directly instead of copying.

    Returns
    -------
    result : np.ndarray
        Updated labels with the label removed entirely.
    success : bool
        Whether the operation succeeded.
    message : str
        Status message.
    """
    result = labels if inplace else labels.copy()
    z, y, x = int(point[0]), int(point[1]), int(point[2])

    label_id = _find_label_near_point(result, z, y, x)
    if label_id == 0:
        return result, False, "Point is not on a label"

    if debug:
        print(f"Delete 3D: label {label_id} entirely")

    mask = result == label_id
    n_voxels = mask.sum()
    result[mask] = 0

    msg = f"Deleted label {label_id} entirely: {n_voxels} voxels removed"
    return result, True, msg
