// Turns a flat list of files into a city: folders become districts (nested platforms),
// files become buildings. Uses a squarified treemap so blocks stay close to square.

export const LEVEL = 0.35; // height of one district platform

export const fileHeight = (lines) => 1.0 + Math.sqrt(Math.max(0, lines)) * 0.9;
const fileSide = (lines) => Math.min(14, 1.5 + Math.sqrt(Math.max(0, lines)) / 7);

function newDir(name, path) {
  return { name, path, dirs: new Map(), files: [], weight: 0, lines: 0, fileCount: 0 };
}

export function buildCity(files) {
  let root = newDir('', '');
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = newDir(parts[i], node.path ? `${node.path}/${parts[i]}` : parts[i]);
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.push(f);
  }

  // A repo wrapped in one folder (common for zips) shouldn't be a single giant district.
  while (root.files.length === 0 && root.dirs.size === 1) root = [...root.dirs.values()][0];
  collapse(root);
  weigh(root);

  const size = Math.sqrt(root.weight) * 1.04;
  const out = { buildings: [], districts: [] };
  layoutDir(root, { x: -size / 2, z: -size / 2, w: size, d: size }, 0, out);

  let maxHeight = 0;
  for (const b of out.buildings) maxHeight = Math.max(maxHeight, b.y0 + b.h);
  return { ...out, size, maxHeight, root };
}

// Merge chains like src/main/java/com/acme into one district so the city isn't all padding.
function collapse(node) {
  for (const [key, child] of [...node.dirs]) {
    let cur = child;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const only = [...cur.dirs.values()][0];
      only.name = `${cur.name}/${only.name}`;
      cur = only;
    }
    if (cur !== child) { node.dirs.delete(key); node.dirs.set(cur.name, cur); }
    collapse(cur);
  }
}

function weigh(node) {
  let w = 0, lines = 0, count = 0;
  for (const f of node.files) {
    const s = fileSide(f.lines) + 0.9;
    f.weight = s * s;
    w += f.weight; lines += f.lines; count++;
  }
  for (const d of node.dirs.values()) {
    weigh(d);
    w += d.weight; lines += d.lines; count += d.fileCount;
  }
  node.weight = w * 1.12 + 12; // headroom for streets and platform edges
  node.lines = lines;
  node.fileCount = count;
}

function layoutDir(node, rect, depth, out) {
  if (depth > 0) {
    out.districts.push({
      x: rect.x + rect.w / 2, z: rect.z + rect.d / 2, w: rect.w, d: rect.d,
      y0: (depth - 1) * LEVEL, h: LEVEL, depth, node,
    });
  }
  const pad = depth === 0 ? 0 : Math.min(1.0, Math.min(rect.w, rect.d) * 0.06);
  const inner = {
    x: rect.x + pad, z: rect.z + pad,
    w: Math.max(0, rect.w - 2 * pad), d: Math.max(0, rect.d - 2 * pad),
  };
  const items = [...node.dirs.values(), ...node.files].sort((a, b) => b.weight - a.weight);
  const base = depth * LEVEL;

  for (const c of squarify(items, inner)) {
    if (c.item.dirs instanceof Map) {
      const street = Math.min(depth === 0 ? 3 : depth === 1 ? 1.8 : 1.0, Math.min(c.w, c.d) * 0.18);
      layoutDir(c.item, {
        x: c.x + street / 2, z: c.z + street / 2,
        w: Math.max(0.01, c.w - street), d: Math.max(0.01, c.d - street),
      }, depth + 1, out);
    } else {
      const sp = Math.min(0.8, Math.min(c.w, c.d) * 0.28);
      let bw = Math.max(0.15, c.w - sp), bd = Math.max(0.15, c.d - sp);
      bw = Math.min(bw, bd * 2.2);
      bd = Math.min(bd, bw * 2.2);
      out.buildings.push({
        x: c.x + c.w / 2, z: c.z + c.d / 2, w: bw, d: bd,
        y0: base, h: fileHeight(c.item.lines), file: c.item, depth,
      });
    }
  }
}

// Squarified treemap (Bruls, Huizing, van Wijk). items must be sorted by weight, descending.
function squarify(items, rect) {
  const out = [];
  let { x, z, w, d } = rect;
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (!items.length || total <= 0 || w <= 0 || d <= 0) return out;
  const scale = (w * d) / total;
  const areas = items.map((i) => i.weight * scale);

  let i = 0;
  while (i < items.length) {
    const side = Math.max(1e-6, Math.min(w, d));
    let end = i, sum = 0, mn = Infinity, mx = 0, best = Infinity;
    while (end < items.length) {
      const a = areas[end];
      const s = sum + a, nmn = Math.min(mn, a), nmx = Math.max(mx, a);
      const worst = Math.max((side * side * nmx) / (s * s), (s * s) / (side * side * nmn));
      if (end > i && worst > best) break;
      best = worst; sum = s; mn = nmn; mx = nmx; end++;
    }
    if (w >= d) {
      const cw = d > 0 ? sum / d : 0;
      let zz = z;
      for (let k = i; k < end; k++) {
        const h = cw > 0 ? areas[k] / cw : 0;
        out.push({ item: items[k], x, z: zz, w: cw, d: h });
        zz += h;
      }
      x += cw; w = Math.max(0, w - cw);
    } else {
      const ch = w > 0 ? sum / w : 0;
      let xx = x;
      for (let k = i; k < end; k++) {
        const ww = ch > 0 ? areas[k] / ch : 0;
        out.push({ item: items[k], x: xx, z, w: ww, d: ch });
        xx += ww;
      }
      z += ch; d = Math.max(0, d - ch);
    }
    i = end;
  }
  return out;
}
