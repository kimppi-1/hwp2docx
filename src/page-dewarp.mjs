// 휜 책 쪽을 평평하게 펴기 — '입체 종이 모형(cubic sheet)' 방식
//
// 책을 펼쳐 찍으면 종이가 제본 쪽으로 둥글게 말려 글줄이 휘고, 제본 가까운 글자는 좁아 보인다.
// 종이를 "가로 방향으로만 휘는 3차 곡면(z = 3차식(x))"으로 보고, 사진 속 글줄이 놓인 자리를
// 가장 잘 설명하는 카메라 위치·곡면 모양을 찾은 뒤, 곡면을 평평하게 펼친 그림을 다시 그린다.
//
// 알고리즘 출처(MIT License):
//   Matt Zucker, page_dewarp — https://github.com/mzucker/page_dewarp  (원 알고리즘·설명 글)
//   Louis Maddox, page-dewarp — https://github.com/lmmx/page-dewarp    (파이썬 판)
//   Eryk Napierała, page-dewarp-js — https://github.com/erykpiast/page-dewarp-js (자바스크립트 판; Powell 최적화 코드 참고)
// 이 파일은 OpenCV 없이(브라우저에서 가볍게) 돌도록 같은 단계를 다시 짠 것이다.
//   글줄 찾기(문턱·팽창·덩어리) → 덩어리 잇기(span) → 표본점 → 초기 자세(평면 호모그래피 분해) → Powell 최소화 → 다시 그리기

const F = 1.2;   // 초점 거리(정규화 좌표)

// ── 작은 도구 ──
function boxShrink(g, W, H, Ht) {
  const s = H / Ht, w = Math.max(1, Math.round(W / s)), h = Math.max(1, Math.round(H / s));
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * s), y1 = Math.max(y0 + 1, Math.floor((y + 1) * s));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * s), x1 = Math.max(x0 + 1, Math.floor((x + 1) * s));
      let a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < H; yy++) for (let xx = x0; xx < x1 && xx < W; xx++) { a += g[yy * W + xx]; n++; }
      o[y * w + x] = n ? a / n : 255;
    }
  }
  return { g: o, w, h, s };
}
// 국소 평균보다 C 넘게 어두우면 글자 (적분 영상)
function adaptiveInv(g, w, h, win, C) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let r = 0; for (let x = 0; x < w; x++) { r += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + r; } }
  const m = new Uint8Array(w * h), r = win >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      m[y * w + x] = g[y * w + x] < s / ((x1 - x0) * (y1 - y0)) - C ? 1 : 0;
    }
  }
  return m;
}
function dilateH(m, w, h, k) {
  const o = new Uint8Array(w * h), r = k >> 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    for (let d = -r; d <= k - 1 - r; d++) { const X = x + d; if (X >= 0 && X < w) o[y * w + X] = 1; }
  }
  return o;
}
function erodeV(m, w, h, k) {
  const o = new Uint8Array(w * h), r = k >> 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let ok = 1;
    for (let d = -r; d <= k - 1 - r && ok; d++) { const Y = y + d; if (Y < 0 || Y >= h || !m[Y * w + x]) ok = 0; }
    o[y * w + x] = ok;
  }
  return o;
}
// 이어진 덩어리 (8-이웃)
function components(m, w, h) {
  const lab = new Int32Array(w * h).fill(-1), comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || lab[i] >= 0) continue;
    const id = comps.length, px = [];
    lab[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop(); px.push(p);
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const q = Y * w + X;
        if (m[q] && lab[q] < 0) { lab[q] = id; stack.push(q); }
      }
    }
    comps.push(px);
  }
  return comps;
}

// 덩어리 정보: 중심, 방향(2차 모멘트), 방향축 위 범위, 세로 두께, 열마다 가운데 높이
function blobInfo(px, w) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, sx = 0, sy = 0;
  for (const p of px) { const x = p % w, y = (p / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; sx += x; sy += y; }
  const n = px.length, cx = sx / n, cy = sy / n;
  let m20 = 0, m11 = 0, m02 = 0;
  for (const p of px) { const dx = p % w - cx, dy = ((p / w) | 0) - cy; m20 += dx * dx; m11 += dx * dy; m02 += dy * dy; }
  m20 /= n; m11 /= n; m02 /= n;
  const T = m20 + m02, D = m20 * m02 - m11 * m11, L1 = T / 2 + Math.sqrt(Math.max(0, T * T / 4 - D));
  let tx = 1, ty = 0;
  if (Math.abs(m11) > 1e-9) { const th = Math.atan2(-(m20 - L1), m11); tx = Math.cos(th); ty = Math.sin(th); }
  else if (m20 < m02) { tx = 0; ty = 1; }
  if (tx < 0) { tx = -tx; ty = -ty; }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const colN = new Int32Array(bw), colY = new Float64Array(bw);
  let lo = Infinity, hi = -Infinity;
  for (const p of px) {
    const x = p % w, y = (p / w) | 0;
    colN[x - x0]++; colY[x - x0] += y;
    const t = tx * (x - cx) + ty * (y - cy);
    if (t < lo) lo = t; if (t > hi) hi = t;
  }
  let thick = 0; for (const v of colN) if (v > thick) thick = v;
  return {
    x0, y0, bw, bh, thick, center: [cx, cy], tangent: [tx, ty], angle: Math.atan2(ty, tx), xr: [lo, hi],
    p0: [cx + tx * lo, cy + ty * lo], p1: [cx + tx * hi, cy + ty * hi],
    colMean: Array.from(colY, (v, i) => (colN[i] ? v / colN[i] : NaN)),
  };
}
const projX = (c, p) => c.tangent[0] * (p[0] - c.center[0]) + c.tangent[1] * (p[1] - c.center[1]);
const angDist = (b, a) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d); };

// ── 투영: (x, y) 평면 좌표 + 3차 곡면 → 사진(정규화) 좌표 ──
function rodrigues(r) {
  const th = Math.hypot(r[0], r[1], r[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const kx = r[0] / th, ky = r[1] / th, kz = r[2] / th, c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return [
    c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
    ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
    kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v,
  ];
}
function projector(p) {
  const R = rodrigues([p[0], p[1], p[2]]), tx = p[3], ty = p[4], tz = p[5];
  const a = Math.max(-0.5, Math.min(0.5, p[6])), b = Math.max(-0.5, Math.min(0.5, p[7]));
  const c3 = a + b, c2 = -2 * a - b, c1 = a;
  return (x, y) => {
    const z = ((c3 * x + c2) * x + c1) * x;
    const X = R[0] * x + R[1] * y + R[2] * z + tx, Y = R[3] * x + R[4] * y + R[5] * z + ty, Z = R[6] * x + R[7] * y + R[8] * z + tz;
    return [F * X / Z, F * Y / Z];
  };
}

// 평면 위 네 모서리 → 카메라 자세 (호모그래피 분해)
function solvePlanarPose(obj, img) {
  // img = H · obj  (8원 연립방정식)
  const A = [], bb = [];
  for (let i = 0; i < 4; i++) {
    const [X, Y] = obj[i], [u, v] = img[i];
    A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); bb.push(u);
    A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]); bb.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let pv = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
    [A[c], A[pv]] = [A[pv], A[c]]; [bb[c], bb[pv]] = [bb[pv], bb[c]];
    for (let r = 0; r < 8; r++) { if (r === c) continue; const k = A[r][c] / A[c][c]; for (let q = c; q < 8; q++) A[r][q] -= k * A[c][q]; bb[r] -= k * bb[c]; }
  }
  const h = bb.map((v, i) => v / A[i][i]);
  const Hm = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  // K⁻¹·H
  const M = Hm.map((row, i) => (i < 2 ? row.map(v => v / F) : row));
  const col = (j) => [M[0][j], M[1][j], M[2][j]];
  let m1 = col(0), m2 = col(1), m3 = col(2);
  let lam = 1 / Math.hypot(...m1);
  if (m3[2] * lam < 0) lam = -lam;
  let r1 = m1.map(v => v * lam), r2 = m2.map(v => v * lam);
  const t = m3.map(v => v * lam);
  // 직교화
  const n1 = Math.hypot(...r1); r1 = r1.map(v => v / n1);
  const d = r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2];
  r2 = r2.map((v, i) => v - d * r1[i]); const n2 = Math.hypot(...r2); r2 = r2.map(v => v / n2);
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  const R = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
  const tr = R[0] + R[4] + R[8], th = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  let rv = [0, 0, 0];
  if (th > 1e-9) { const s = 2 * Math.sin(th); rv = [(R[7] - R[5]) / s * th, (R[2] - R[6]) / s * th, (R[3] - R[1]) / s * th]; }
  return { rvec: rv, tvec: t };
}

// ── Powell 최소화 (한 방향씩 Brent 선 탐색) ──
function brent1D(f, x0) {
  let a = x0, b = x0 + 0.1, fa = f(a), fb = f(b), s = 0.1;
  let c;
  if (fb > fa) { s = -s; b = x0 + s; fb = f(b); }
  if (fb > fa) { a = x0 - 0.1; b = x0; c = x0 + 0.1; }
  else {
    c = b + s; let fc = f(c), it = 0;
    while (fc < fb && it++ < 40) { a = b; b = c; fb = fc; s *= 1.618; c = b + s; fc = f(c); }
  }
  if (a > c) [a, c] = [c, a];
  let x = b, w = b, v = b, fx = f(x), fw = fx, fv = fx, e = 0, dd = 0;
  for (let i = 0; i < 60; i++) {
    const xm = 0.5 * (a + c), tol1 = 1e-6 * Math.abs(x) + 1e-10, tol2 = 2 * tol1;
    if (Math.abs(x - xm) <= tol2 - 0.5 * (c - a)) break;
    let u;
    if (Math.abs(e) > tol1) {
      const r = (x - w) * (fx - fv); let q = (x - v) * (fx - fw), pp = (x - v) * q - (x - w) * r;
      q = 2 * (q - r); if (q > 0) pp = -pp; q = Math.abs(q);
      const et = e; e = dd;
      if (Math.abs(pp) >= Math.abs(0.5 * q * et) || pp <= q * (a - x) || pp >= q * (c - x)) { e = x >= xm ? a - x : c - x; dd = 0.381966 * e; }
      else { dd = pp / q; u = x + dd; if (u - a < tol2 || c - u < tol2) dd = xm - x >= 0 ? tol1 : -tol1; }
    } else { e = x >= xm ? a - x : c - x; dd = 0.381966 * e; }
    u = Math.abs(dd) >= tol1 ? x + dd : x + (dd >= 0 ? tol1 : -tol1);
    const fu = f(u);
    if (fu <= fx) { if (u >= x) a = x; else c = x; v = w; w = x; x = u; fv = fw; fw = fx; fx = fu; }
    else { if (u < x) a = u; else c = u; if (fu <= fw || w === x) { v = w; w = u; fv = fw; fw = fu; } else if (fu <= fv || v === x || v === w) { v = u; fv = fu; } }
  }
  return x;
}
function powell(f, x0, { maxIter = 40, tol = 1e-7, timeLimit = 4000 } = {}) {
  const n = x0.length, x = Float64Array.from(x0), dirs = [];
  for (let i = 0; i < n; i++) { const d = new Float64Array(n); d[i] = 1; dirs.push(d); }
  const tmp = new Float64Array(n), xo = new Float64Array(n), pt = new Float64Array(n), del = new Float64Array(n);
  const line = (d) => {
    let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(d[i]));
    if (mx < 1e-12) return 0;
    const al = brent1D((t) => { for (let i = 0; i < n; i++) tmp[i] = x[i] + t * d[i]; return f(tmp); }, 0);
    for (let i = 0; i < n; i++) x[i] += al * d[i];
    return al;
  };
  let fx = f(x);
  const t0 = Date.now();
  for (let it = 0; it < maxIter; it++) {
    xo.set(x); const fo = fx; let big = 0, bi = -1;
    for (let i = 0; i < n; i++) { const fb = fx; if (line(dirs[i])) { fx = f(x); if (fb - fx > big) { big = fb - fx; bi = i; } } }
    if (Math.abs(fo - fx) < tol || Date.now() - t0 > timeLimit) break;
    for (let i = 0; i < n; i++) { del[i] = x[i] - xo[i]; pt[i] = x[i] + del[i]; }
    const fp = f(pt);
    if (fp < fx && bi >= 0 && 2 * (fo - 2 * fx + fp) * (fo - fx - big) ** 2 < big * (fo - fp) ** 2) { if (line(del)) { fx = f(x); dirs[bi] = Float64Array.from(del); } }
  }
  return x;
}

// ── 본체: 휜 정도를 재서 '펴기 지도'를 만든다 ──
// g: 쪽 하나의 회색 그림(0~255, 흰 바탕), W×H. 실패하면 null.
export function sheetDewarpMap(g, W, H, opts = {}) {
  const SH = opts.small || 900;
  const sm = boxShrink(g, W, H, Math.min(SH, H));
  const { w, h } = sm;
  // 1) 글자 덩어리: 국소 문턱 → 가로로 이어 붙이기 → 세로로 살짝 깎기
  let m = adaptiveInv(sm.g, w, h, 55, 18);
  // 테두리(종이 가장자리·손가락) 빼기
  const mx = Math.round(w * 0.03), my = Math.round(h * 0.02);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < mx || x >= w - mx || y < my || y >= h - my) m[y * w + x] = 0;
  // 글자 높이 어림: 팽창 전 덩어리 높이의 가운값
  const raw = components(m, w, h).filter(px => px.length >= 4);
  const hts = raw.map(px => { let a = Infinity, b = -Infinity; for (const p of px) { const y = (p / w) | 0; if (y < a) a = y; if (y > b) b = y; } return b - a + 1; }).filter(v => v >= 3).sort((a, b) => a - b);
  const th = hts.length ? hts[hts.length >> 1] : 8;
  const dk = Math.max(5, Math.round(th * 0.9)) | 1;
  m = erodeV(dilateH(m, w, h, dk), w, h, th >= 8 ? 3 : 1);
  // 2) 덩어리 거르기: 가로로 길고(글줄 조각), 너무 두껍지 않은 것만
  const minW = Math.max(12, th * 1.5), maxThick = Math.max(8, th * 1.8);
  let C = components(m, w, h).map(px => blobInfo(px, w)).filter(c => c.bw >= minW && c.bw >= 1.5 * c.bh && c.thick <= maxThick);
  if (C.length < 8) return null;
  // 3) 이웃 덩어리 잇기 (같은 글줄)
  const maxLen = th * 8, edges = [];
  C.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  for (let i = 0; i < C.length; i++) for (let j = 0; j < i; j++) {
    let A = C[i], B = C[j];
    if (A.p0[0] > B.p1[0]) [A, B] = [B, A];
    const ov = Math.max(Math.min(A.xr[1], projX(A, B.p1)) - Math.max(A.xr[0], projX(A, B.p0)), Math.min(B.xr[1], projX(B, A.p1)) - Math.max(B.xr[0], projX(B, A.p0)));
    const oa = Math.atan2(B.center[1] - A.center[1], B.center[0] - A.center[0]);
    const da = Math.max(angDist(A.angle, oa), angDist(B.angle, oa)) * 180 / Math.PI;
    const dist = Math.hypot(B.p0[0] - A.p1[0], B.p0[1] - A.p1[1]);
    if (dist > maxLen || ov > 1 || da > 7.5) continue;
    edges.push({ s: dist + da * 10, A, B });
  }
  edges.sort((a, b) => a.s - b.s);
  for (const { A, B } of edges) if (!A.succ && !B.pred) { A.succ = B; B.pred = A; }
  const spans = [], left = new Set(C);
  while (left.size) {
    let c = left.values().next().value;
    while (c.pred) c = c.pred;
    const span = []; let wsum = 0;
    while (c) { left.delete(c); span.push(c); wsum += c.xr[1] - c.xr[0]; c = c.succ; }
    if (wsum > Math.max(30, w * 0.12)) spans.push(span);
  }
  if (spans.length < 4) return null;
  // 4) 표본점: 덩어리 열마다 가운데 높이, 일정 간격으로 (정규화 좌표)
  const scl = 2 / Math.max(w, h), ox = w / 2, oy = h / 2;
  const n2 = (x, y) => [(x - ox) * scl, (y - oy) * scl];
  const step = Math.max(6, Math.round(w / 60));
  let spanPts = spans.map(span => {
    const pts = [];
    for (const c of span) for (let k = Math.floor(((c.bw - 1) % step) / 2); k < c.bw; k += step) if (Number.isFinite(c.colMean[k])) pts.push(n2(c.x0 + k, c.colMean[k]));
    return pts;
  }).filter(p => p.length >= 2);
  // 점이 너무 많으면 줄마다 솎기(계산 시간)
  const total = spanPts.reduce((a, p) => a + p.length, 0);
  if (total > 500) { const k = Math.ceil(total / 500); spanPts = spanPts.map(p => p.filter((_, i) => i % k === 0 || i === p.length - 1)); }
  // 5) 쪽의 가로·세로 축 (글줄 방향 평균)
  let ex = 0, ey = 0, ew = 0;
  for (const p of spanPts) {
    const n = p.length; let mxp = 0, myp = 0; for (const q of p) { mxp += q[0]; myp += q[1]; } mxp /= n; myp /= n;
    let cxx = 0, cxy = 0, cyy = 0; for (const q of p) { const dx = q[0] - mxp, dy = q[1] - myp; cxx += dx * dx; cxy += dx * dy; cyy += dy * dy; }
    const T = cxx + cyy, D = cxx * cyy - cxy * cxy, L1 = T / 2 + Math.sqrt(Math.max(0, T * T / 4 - D));
    let vx = 1, vy = 0; if (Math.abs(cxy) > 1e-12) { const t = Math.atan2(-(cxx - L1), cxy); vx = Math.cos(t); vy = Math.sin(t); }
    if (vx < 0) { vx = -vx; vy = -vy; }
    const wt = Math.hypot(p[n - 1][0] - p[0][0], p[n - 1][1] - p[0][1]);
    ex += vx * wt; ey += vy * wt; ew += wt;
  }
  let xd = [ex / ew, ey / ew]; const nx = Math.hypot(...xd); xd = xd.map(v => v / nx);
  const yd = [-xd[1], xd[0]];
  // 펼 범위는 쪽 전체(가장자리 글자가 잘리지 않게, 조금 넉넉히)
  const ex2 = w * 0.01, ey2 = h * 0.01;
  const outline = [n2(-ex2, -ey2), n2(w + ex2, -ey2), n2(w + ex2, h + ey2), n2(-ex2, h + ey2)];
  const PX = q => q[0] * xd[0] + q[1] * xd[1], PY = q => q[0] * yd[0] + q[1] * yd[1];
  const pxs = outline.map(PX), pys = outline.map(PY);
  const x0 = Math.min(...pxs), x1 = Math.max(...pxs), y0 = Math.min(...pys), y1 = Math.max(...pys);
  const corner = (cx, cy) => [cx * xd[0] + cy * yd[0], cx * xd[1] + cy * yd[1]];
  const corners = [corner(x0, y0), corner(x1, y0), corner(x1, y1), corner(x0, y1)];
  const pageW = x1 - x0, pageH = y1 - y0;
  // 6) 초기값: 평평한 종이로 보고 자세, 곡면 0, 줄마다 y, 점마다 x
  const pose = solvePlanarPose([[0, 0], [pageW, 0], [pageW, pageH], [0, pageH]], corners);
  const ycs = spanPts.map(p => p.reduce((a, q) => a + PY(q), 0) / p.length - y0);
  const xcs = spanPts.map(p => p.map(q => PX(q) - x0));
  const params = [...pose.rvec, ...pose.tvec, 0, 0, ...ycs, ...xcs.flat()];
  const dst = spanPts.flat();
  const nS = spanPts.length, idx = [];
  spanPts.forEach((p, si) => p.forEach(() => idx.push(si)));
  const obj = (pv) => {
    const P = projector(pv); let e = 0;
    for (let i = 0; i < dst.length; i++) {
      const [u, v] = P(pv[8 + nS + i], pv[8 + idx[i]]);
      const du = dst[i][0] - u, dv = dst[i][1] - v; e += du * du + dv * dv;
    }
    return e;
  };
  const e0 = obj(params);
  // 먼저 자세·곡면만(빠르게), 다음에 모두
  const fitPose = powell((q) => obj([...q, ...params.slice(8)]), params.slice(0, 8), { maxIter: 20, timeLimit: 1500 });
  for (let i = 0; i < 8; i++) params[i] = fitPose[i];
  const best = powell(obj, params, { maxIter: opts.maxIter || 12, timeLimit: opts.timeLimit || 6000 });
  const e1 = obj(best);
  if (!(e1 < e0) || !Number.isFinite(e1)) return null;
  const rms = Math.sqrt(e1 / dst.length) / scl;   // 화소(작은 그림) 단위 평균 오차
  // 곡면을 없앴을 때 오차(휜 정도가 실제로 의미 있는지 가늠)
  const flatP = Float64Array.from(best); flatP[6] = 0; flatP[7] = 0;
  const rmsFlat = Math.sqrt(obj(flatP) / dst.length) / scl;
  // 7) 펴기 지도: 평평한 쪽 좌표 격자 → 사진 좌표
  const P = projector(best);
  const outH = H, outW = Math.max(16, Math.round(H * pageW / pageH));
  const dec = 16, gw = Math.ceil(outW / dec) + 1, gh = Math.ceil(outH / dec) + 1;
  const mapX = new Float32Array(gw * gh), mapY = new Float32Array(gw * gh);
  const S = Math.max(W, H) / 2;   // 정규화 → 원 그림 화소
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const fx = Math.min(1, (i * dec) / (outW - 1)), fy = Math.min(1, (j * dec) / (outH - 1));
    const [u, v] = P(fx * pageW, fy * pageH);
    mapX[j * gw + i] = u * S + W / 2; mapY[j * gw + i] = v * S + H / 2;
  }
  const a = Math.max(-0.5, Math.min(0.5, best[6])), b = Math.max(-0.5, Math.min(0.5, best[7]));
  return { outW, outH, gw, gh, dec, mapX, mapY, curvature: Math.abs(a) + Math.abs(b), rms, rmsFlat, spans: spanPts.length };
}

// 지도대로 다시 그리기 (양선형 보간; 밖은 흰색)
export function applyDewarpMap(g, W, H, M, fill = 255) {
  const { outW, outH, gw, dec, mapX, mapY } = M;
  const o = new Uint8Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const gy = y / dec, j0 = Math.floor(gy), ty = gy - j0, j1 = Math.min(M.gh - 1, j0 + 1);
    for (let x = 0; x < outW; x++) {
      const gx = x / dec, i0 = Math.floor(gx), tx = gx - i0, i1 = Math.min(gw - 1, i0 + 1);
      const q00 = j0 * gw + i0, q01 = j0 * gw + i1, q10 = j1 * gw + i0, q11 = j1 * gw + i1;
      const sx = (mapX[q00] * (1 - tx) + mapX[q01] * tx) * (1 - ty) + (mapX[q10] * (1 - tx) + mapX[q11] * tx) * ty;
      const sy = (mapY[q00] * (1 - tx) + mapY[q01] * tx) * (1 - ty) + (mapY[q10] * (1 - tx) + mapY[q11] * tx) * ty;
      const X = Math.floor(sx), Y = Math.floor(sy), fx = sx - X, fy = sy - Y;
      if (X < 0 || Y < 0 || X >= W - 1 || Y >= H - 1) { o[y * outW + x] = fill; continue; }
      const i = Y * W + X;
      o[y * outW + x] = g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) + g[i + W] * (1 - fx) * fy + g[i + W + 1] * fx * fy;
    }
  }
  return o;
}

// 원래 그림의 점 → 편 그림의 점 (지도 격자에서 가장 가까운 칸을 찾아 근사)
export function invertPoint(M, x, y) {
  const { gw, gh, dec, mapX, mapY, outW, outH } = M;
  let bi = 0, bd = Infinity;
  for (let k = 0; k < gw * gh; k++) { const d = (mapX[k] - x) ** 2 + (mapY[k] - y) ** 2; if (d < bd) { bd = d; bi = k; } }
  let i = bi % gw, j = (bi / gw) | 0;
  // 이웃 칸과의 기울기로 한 번 더 다듬기
  const i1 = Math.min(gw - 1, i + 1), j1 = Math.min(gh - 1, j + 1);
  const ax = mapX[j * gw + i1] - mapX[bi], ay = mapY[j * gw + i1] - mapY[bi];
  const bx = mapX[j1 * gw + i] - mapX[bi], by = mapY[j1 * gw + i] - mapY[bi];
  const det = ax * by - ay * bx, dx = x - mapX[bi], dy = y - mapY[bi];
  let u = 0, v = 0;
  if (Math.abs(det) > 1e-9) { u = (dx * by - dy * bx) / det; v = (ax * dy - ay * dx) / det; }
  return [Math.max(0, Math.min(outW, (i + Math.max(-1, Math.min(1, u))) * dec)), Math.max(0, Math.min(outH, (j + Math.max(-1, Math.min(1, v))) * dec))];
}
