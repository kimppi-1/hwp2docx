// PDF 그림 선·채우기 → 표 찾기
// 표 선은 PDF에 '가는 사각형 채우기'(워드) 또는 '선 긋기'(한글)로 들어 있다. 칸 배경은 사각형 채우기.
// 단위: pt, 좌표는 쪽 왼쪽 위가 (0,0)

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const hex = (c) => c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const isWhite = (c) => /^(F[A-F0-9]){3}$/.test(c) && parseInt(c.slice(0, 2), 16) > 0xF4 && parseInt(c.slice(2, 4), 16) > 0xF4 && parseInt(c.slice(4, 6), 16) > 0xF4;

// 연산 목록에서 선(가로·세로)과 채운 사각형, 둥근 상자·대각선·복잡한 벡터 경로를 뽑는다. vpT: 화면 변환(viewport.transform)
export function extractGraphics(ops, O, vpT) {
  const segs = [], fills = [], roundRects = [], diags = [], paths = [];
  let ctm = [1, 0, 0, 1, 0, 0], fill = '000000', stroke = '000000', lw = 1;
  const stack = [];
  let path = null;
  const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], a = ops.argsArray[i];
    switch (fn) {
      case O.save: stack.push([ctm, fill, stroke, lw]); break;
      case O.restore: { const s = stack.pop(); if (s) [ctm, fill, stroke, lw] = s; break; }
      case O.transform: ctm = mul(ctm, a); break;
      case O.setFillRGBColor: fill = hex([a[0], a[1], a[2]]); break;
      case O.setFillGray: fill = hex([a[0] * 255, a[0] * 255, a[0] * 255]); break;
      case O.setStrokeRGBColor: stroke = hex([a[0], a[1], a[2]]); break;
      case O.setStrokeGray: stroke = hex([a[0] * 255, a[0] * 255, a[0] * 255]); break;
      case O.setLineWidth: lw = a[0]; break;
      case O.constructPath: {
        // a = [ops, coords, minMax]
        const pops = a[0], c = a[1]; let k = 0;
        const subs = path ? path.subs : [];
        let cur = subs.at(-1) && !subs.at(-1).closed ? subs.at(-1) : null;
        const M = mul(vpT, ctm);
        const pt = (x, y) => apply(M, x, y);
        const bez = (p0, p1, p2, p3, t) => {
          const u = 1 - t;
          return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
        };
        for (const op of pops) {
          if (op === O.rectangle) {
            const [x, y, w, h] = [c[k], c[k + 1], c[k + 2], c[k + 3]]; k += 4;
            const p0 = pt(x, y), p1 = pt(x + w, y), p2 = pt(x + w, y + h), p3 = pt(x, y + h);
            subs.push({ pts: [p0, p1, p2, p3], cmds: [{ op: 'M', x: p0[0], y: p0[1] }, { op: 'L', x: p1[0], y: p1[1] }, { op: 'L', x: p2[0], y: p2[1] }, { op: 'L', x: p3[0], y: p3[1] }, { op: 'Z' }], closed: true, rect: true });
            cur = null;
          } else if (op === O.moveTo) {
            const p0 = pt(c[k], c[k + 1]); k += 2;
            cur = { pts: [p0], cmds: [{ op: 'M', x: p0[0], y: p0[1] }] }; subs.push(cur);
          } else if (op === O.lineTo) {
            const p0 = pt(c[k], c[k + 1]); k += 2;
            if (!cur) { cur = { pts: [p0], cmds: [{ op: 'M', x: p0[0], y: p0[1] }] }; subs.push(cur); }
            else { cur.pts.push(p0); cur.cmds.push({ op: 'L', x: p0[0], y: p0[1] }); }
          } else if (op === O.curveTo) {
            const p1 = pt(c[k], c[k + 1]), p2 = pt(c[k + 2], c[k + 3]), p3 = pt(c[k + 4], c[k + 5]); k += 6;
            if (cur && cur.pts.length) {
              const p0 = cur.pts.at(-1);
              cur.curve = true;
              cur.cmds.push({ op: 'C', x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], x: p3[0], y: p3[1] });
              for (const t of [0.25, 0.5, 0.75, 1]) cur.pts.push(bez(p0, p1, p2, p3, t));
            }
          } else if (op === O.curveTo2 || op === O.curveTo3) {
            const pa = pt(c[k], c[k + 1]), pb = pt(c[k + 2], c[k + 3]); k += 4;
            if (cur && cur.pts.length) {
              const p0 = cur.pts.at(-1);
              const p1 = op === O.curveTo2 ? p0 : pa, p2 = pa, p3 = pb;
              cur.curve = true;
              cur.cmds.push({ op: 'C', x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], x: p3[0], y: p3[1] });
              for (const t of [0.25, 0.5, 0.75, 1]) cur.pts.push(bez(p0, p1, p2, p3, t));
            }
          } else if (op === O.closePath) {
            if (cur) { cur.closed = true; cur.cmds.push({ op: 'Z' }); }
          }
        }
        path = { subs, scale: scaleOf(M) };
        break;
      }
      case O.fill: case O.eoFill: case O.fillStroke: case O.eoFillStroke: case O.closeFillStroke: case O.closeEOFillStroke:
      case O.stroke: case O.closeStroke: {
        if (!path) break;
        const doFill = fn !== O.stroke && fn !== O.closeStroke;
        const doStroke = fn !== O.fill && fn !== O.eoFill;
        const eo = fn === O.eoFill || fn === O.eoFillStroke || fn === O.closeEOFillStroke;
        const lwp = Math.max(0.1, lw * path.scale);
        for (const s of path.subs) {
          if (s.pts.length < 2) continue;
          const xs = s.pts.map(p => p[0]), ys = s.pts.map(p => p[1]);
          const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
          if (s.curve) {
            // 둥근 직사각형 판별: 4개의 축 정렬 직선(위·아래·왼쪽·오른쪽)과 4개의 모서리 곡선으로 이루어진 닫힌 도형
            const lines = [], curves = s.cmds.filter(c => c.op === 'C').length;
            let lx = 0, ly = 0;
            for (const cmd of s.cmds) {
              if (cmd.op === 'M' || cmd.op === 'C') { lx = cmd.x; ly = cmd.y; }
              else if (cmd.op === 'L') { lines.push([lx, ly, cmd.x, cmd.y]); lx = cmd.x; ly = cmd.y; }
            }
            const w = x1 - x0, h = y1 - y0;
            const hEdges = lines.filter(([ax, ay, bx, by]) => Math.abs(ay - by) < 0.5 && Math.abs(bx - ax) > 0.3 * w && (Math.abs(ay - y0) < 1.5 || Math.abs(ay - y1) < 1.5));
            const vEdges = lines.filter(([ax, ay, bx, by]) => Math.abs(ax - bx) < 0.5 && Math.abs(by - ay) > 0.3 * h && (Math.abs(ax - x0) < 1.5 || Math.abs(ax - x1) < 1.5));
            if (w > 6 && h > 6 && hEdges.length === 2 && vEdges.length === 2 && curves >= 4 && curves <= 8) {
              const rx = Math.max(1, (w - Math.abs(hEdges[0][2] - hEdges[0][0])) / 2);
              const ratio = Math.max(5, Math.min(50, Math.round((rx / (Math.min(w, h) / 2)) * 50)));
              roundRects.push({ x0, y0, x1, y1, ratio, fill: doFill && !isWhite(fill) ? fill : null, stroke: doStroke ? { color: stroke, w: lwp } : null });
            } else if (w > 1.5 || h > 1.5) {
              paths.push({ cmds: s.cmds, x0, y0, x1, y1, fill: doFill ? fill : null, eo, stroke: doStroke ? { color: stroke, w: lwp } : null });
            }
            continue;
          }
          const axis = s.pts.every((p, j) => { const q = s.pts[(j + 1) % s.pts.length]; return Math.abs(p[0] - q[0]) < 0.3 || Math.abs(p[1] - q[1]) < 0.3; });
          if (!axis) {
            if (s.pts.length === 2 && doStroke && !doFill && Math.hypot(s.pts[1][0] - s.pts[0][0], s.pts[1][1] - s.pts[0][1]) > 2) {
              diags.push({ d: 'diag', x1: s.pts[0][0], y1: s.pts[0][1], x2: s.pts[1][0], y2: s.pts[1][1], w: lwp, color: stroke });
            } else if (x1 - x0 > 1.5 || y1 - y0 > 1.5) {
              paths.push({ cmds: s.cmds, x0, y0, x1, y1, fill: doFill ? fill : null, eo, stroke: doStroke ? { color: stroke, w: lwp } : null });
            }
            continue;
          }
          if (doFill && axis && s.pts.length >= 4) {
            const w = x1 - x0, h = y1 - y0;
            if (h <= 2.6 && w > 2) segs.push({ d: 'h', y: (y0 + y1) / 2, a: x0, b: x1, w: Math.max(0.1, h), color: fill });
            else if (w <= 2.6 && h > 2) segs.push({ d: 'v', x: (x0 + x1) / 2, a: y0, b: y1, w: Math.max(0.1, w), color: fill });
            else if (w > 2 && h > 2 && !isWhite(fill)) fills.push({ x0, y0, x1, y1, color: fill });
          }
          if (doStroke) {
            const n = s.pts.length, pts = (s.closed || s.rect) && n > 2 ? [...s.pts, s.pts[0]] : s.pts;
            for (let j = 1; j < pts.length; j++) {
              const p = pts[j - 1], q = pts[j];
              if (Math.abs(p[1] - q[1]) < 0.3 && Math.abs(p[0] - q[0]) > 2) segs.push({ d: 'h', y: p[1], a: Math.min(p[0], q[0]), b: Math.max(p[0], q[0]), w: lwp, color: stroke });
              else if (Math.abs(p[0] - q[0]) < 0.3 && Math.abs(p[1] - q[1]) > 2) segs.push({ d: 'v', x: p[0], a: Math.min(p[1], q[1]), b: Math.max(p[1], q[1]), w: lwp, color: stroke });
            }
          }
        }
        path = null;
        break;
      }
      case O.endPath: path = null; break;
      default: break;
    }
  }
  return { segs, fills, roundRects, diags, paths };
}

// 같은 줄 위에 이어진 선 조각을 하나로
export function mergeSegs(segs, d) {
  const key = d === 'h' ? 'y' : 'x';
  const list = segs.filter(s => s.d === d).sort((p, q) => p[key] - q[key] || p.a - q.a);
  const out = [];
  for (const s of list) {
    const o = out.find(o => Math.abs(o[key] - s[key]) < 0.8 && s.a <= o.b + 1.2 && s.b >= o.a - 1.2);
    if (o) { o.a = Math.min(o.a, s.a); o.b = Math.max(o.b, s.b); o.w = Math.max(o.w, s.w); }
    else out.push({ ...s });
  }
  return out;
}
const cluster = (vals, tol) => {
  const v = [...vals].sort((a, b) => a - b), out = [];
  for (const x of v) { if (out.length && x - out.at(-1).last <= tol) { const c = out.at(-1); c.sum += x; c.n++; c.last = x; } else out.push({ sum: x, n: 1, last: x }); }
  return out.map(c => c.sum / c.n);
};

// 표 찾기: 서로 이어진 가로선·세로선 묶음 하나 = 표 하나.
// 선이 없는 표(칸 배경만 있는 표·색 상자)는 서로 닿은 배경 사각형 묶음으로 찾는다.
// (워드는 칸 안 문단 배경을 칸보다 안쪽에 따로 칠하므로, 선이 있는 표에서는 배경 가장자리를 칸 경계로 쓰지 않는다)
function components(hs, vs, tol = 1.6) {
  const nodes = [...hs, ...vs];
  const parent = nodes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  hs.forEach((h, i) => vs.forEach((v, j) => {
    if (v.x >= h.a - tol && v.x <= h.b + tol && h.y >= v.a - tol && h.y <= v.b + tol) parent[find(i)] = find(hs.length + j);
  }));
  const groups = new Map();
  nodes.forEach((n, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); });
  return [...groups.values()];
}
export function detectTables(g) {
  const H = mergeSegs(g.segs, 'h').filter(s => s.b - s.a > 3);
  const V = mergeSegs(g.segs, 'v').filter(s => s.b - s.a > 3);
  const tables = [];
  const make = (gh, gv) => {
    const ys = cluster(gh.map(s => s.y), 1.2), xs = cluster(gv.map(s => s.x), 1.2);
    if (ys.length < 2 || xs.length < 2) return;
    const x0 = xs[0], x1 = xs.at(-1), y0 = ys[0], y1 = ys.at(-1);
    if (x1 - x0 < 10 || y1 - y0 < 5) return;
    tables.push({ xs, ys, x0, x1, y0, y1, H: gh, V: gv, fills: g.fills.filter(f => (f.x0 + f.x1) / 2 >= x0 && (f.x0 + f.x1) / 2 <= x1 && (f.y0 + f.y1) / 2 >= y0 && (f.y0 + f.y1) / 2 <= y1) });
  };
  // 1) 보이는 선으로 된 표
  for (const grp of components(H, V)) {
    const gh = grp.filter(n => n.d === 'h'), gv = grp.filter(n => n.d === 'v');
    if (gh.length >= 2 && gv.length >= 2) make(gh, gv);
  }
  // 2) 선 표 밖의 배경 사각형: 서로 닿은 것끼리 묶어 상자·배경 표로
  const inTable = (f) => tables.some(t => (f.x0 + f.x1) / 2 >= t.x0 - 1 && (f.x0 + f.x1) / 2 <= t.x1 + 1 && (f.y0 + f.y1) / 2 >= t.y0 - 1 && (f.y0 + f.y1) / 2 <= t.y1 + 1);
  const loose = g.fills.filter(f => !inTable(f));
  // 다른 배경 안에 쏙 들어간 배경(문단 배경)은 칸 경계로 쓰지 않는다
  const outer = loose.filter(f => !loose.some(o => o !== f && o.x0 <= f.x0 + 0.5 && o.x1 >= f.x1 - 0.5 && o.y0 <= f.y0 + 0.5 && o.y1 >= f.y1 - 0.5 && (o.x1 - o.x0) * (o.y1 - o.y0) > (f.x1 - f.x0) * (f.y1 - f.y0)));
  const eh = [], ev = [];
  for (const f of outer) {
    eh.push({ d: 'h', y: f.y0, a: f.x0, b: f.x1, w: 0, inv: true }, { d: 'h', y: f.y1, a: f.x0, b: f.x1, w: 0, inv: true });
    ev.push({ d: 'v', x: f.x0, a: f.y0, b: f.y1, w: 0, inv: true }, { d: 'v', x: f.x1, a: f.y0, b: f.y1, w: 0, inv: true });
  }
  // 상자 둘레에 그은 선도 함께 쓴다
  const nearBox = (s) => outer.some(f => s.d === 'h' ? (Math.abs(s.y - f.y0) < 1.5 || Math.abs(s.y - f.y1) < 1.5) && s.a < f.x1 && s.b > f.x0 : (Math.abs(s.x - f.x0) < 1.5 || Math.abs(s.x - f.x1) < 1.5) && s.a < f.y1 && s.b > f.y0);
  const freeH = H.filter(s => !tables.some(t => s.y >= t.y0 - 1 && s.y <= t.y1 + 1 && s.a < t.x1 && s.b > t.x0) && nearBox(s));
  const freeV = V.filter(s => !tables.some(t => s.x >= t.x0 - 1 && s.x <= t.x1 + 1 && s.a < t.y1 && s.b > t.y0) && nearBox(s));
  for (const grp of components([...eh, ...freeH], [...ev, ...freeV], 0.8)) {
    const gh = grp.filter(n => n.d === 'h'), gv = grp.filter(n => n.d === 'v');
    if (gh.length >= 2 && gv.length >= 2) make(gh, gv);
  }
  // 다른 표 안에 들어간 작은 묶음은 버린다
  return tables.filter(t => !tables.some(u => u !== t && u.x0 <= t.x0 + 1 && u.x1 >= t.x1 - 1 && u.y0 <= t.y0 + 1 && u.y1 >= t.y1 - 1 && (u.x1 - u.x0) * (u.y1 - u.y0) > (t.x1 - t.x0) * (t.y1 - t.y0)));
}

// 표 하나의 칸 나누기: 칸 경계에 선(또는 배경 가장자리)이 없으면 이웃 칸과 합친다
export function buildGrid(t) {
  const nC = t.xs.length - 1, nR = t.ys.length - 1;
  const covers = (list, at, key, mid, d) => list.find(s => Math.abs(s[key] - at) < 1.3 && s.a <= mid + 0.5 && s.b >= mid - 0.5 && s.d === d);
  const id = Array.from({ length: nR }, (_, r) => Array.from({ length: nC }, (_, c) => r * nC + c));
  const parent = Array.from({ length: nR * nC }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const all = [...t.H, ...t.V];
  for (let r = 0; r < nR; r++) for (let c = 0; c < nC - 1; c++) {
    const ym = (t.ys[r] + t.ys[r + 1]) / 2;
    if (!covers(all, t.xs[c + 1], 'x', ym, 'v')) parent[find(id[r][c + 1])] = find(id[r][c]);
  }
  for (let r = 0; r < nR - 1; r++) for (let c = 0; c < nC; c++) {
    const xm = (t.xs[c] + t.xs[c + 1]) / 2;
    if (!covers(all, t.ys[r + 1], 'y', xm, 'h')) parent[find(id[r + 1][c])] = find(id[r][c]);
  }
  const groups = new Map();
  for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) { const k = find(id[r][c]); if (!groups.has(k)) groups.set(k, { r0: r, r1: r, c0: c, c1: c }); const g = groups.get(k); g.r0 = Math.min(g.r0, r); g.r1 = Math.max(g.r1, r); g.c0 = Math.min(g.c0, c); g.c1 = Math.max(g.c1, c); }
  // 합친 모양이 사각형이 아니면(ㄱ자 등) 사각형으로 넓힌다
  const owner = Array.from({ length: nR }, () => new Array(nC).fill(null));
  const cells = [];
  for (const g of [...groups.values()].sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0)) {
    let free = true;
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) if (owner[r][c]) free = false;
    if (!free) continue;
    const cell = { row: g.r0, col: g.c0, rowSpan: g.r1 - g.r0 + 1, colSpan: g.c1 - g.c0 + 1, x0: t.xs[g.c0], x1: t.xs[g.c1 + 1], y0: t.ys[g.r0], y1: t.ys[g.r1 + 1] };
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) owner[r][c] = cell;
    cells.push(cell);
  }
  // 칸마다 테두리(보이는 선만)와 배경
  const visible = (d, at, a, b) => {
    const key = d === 'h' ? 'y' : 'x';
    const mid = (a + b) / 2;
    const s = (d === 'h' ? t.H : t.V).find(s => !s.inv && Math.abs(s[key] - at) < 1.3 && s.a <= mid + 0.5 && s.b >= mid - 0.5);
    return s ? { w: s.w, color: s.color } : null;
  };
  for (const c of cells) {
    c.borders = { top: visible('h', c.y0, c.x0, c.x1), bottom: visible('h', c.y1, c.x0, c.x1), left: visible('v', c.x0, c.y0, c.y1), right: visible('v', c.x1, c.y0, c.y1) };
    const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
    const f = t.fills.filter(f => f.x0 <= cx && f.x1 >= cx && f.y0 <= cy && f.y1 >= cy).sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0))[0];
    if (f) c.fill = f.color;
  }
  return { nR, nC, cells };
}
