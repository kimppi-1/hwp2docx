// 책·문서 사진(JPG·PNG) → 한글 파일
// 1) 사진에서 종이 네 모서리를 찾아 반듯하게 펴고(원근·기울기 바로잡기)
// 2) 글자를 읽은 뒤(OCR — 바깥에서 넘겨받는 함수)
// 3) 줄 위치로 판형·여백·글자 크기·줄 간격·자간·들여쓰기·문단을 재서
// 4) pdf-convert가 쓰는 문단 모델로 돌려준다.
// 그림 해독(디코딩)과 OCR은 실행 환경마다 달라 함수로 받는다:
//   decode(bytes, name) → { w, h, data: RGBA Uint8ClampedArray }
//   ocr(png Uint8Array, w, h) → [{ text, x0, y0, x1, y1, words: [{ text, x0, y0, x1, y1 }] }]  (줄 단위)
import { encodePng } from './pdf-read.mjs';
import { HANGUL_ADVANCE, HWP_SPACE } from './font-metrics.mjs';
import { sheetDewarpMap, applyDewarpMap, invertPoint, marginMap, applyMarginMap, marginInvX } from './page-dewarp.mjs';

const MM = 72 / 25.4;   // 1mm = 2.8346pt

// 흔한 책·종이 판형 (가로×세로 mm)
export const BOOK_SIZES = {
  auto: null,
  sinkuk: { w: 152, h: 225, name: '신국판' },
  '46': { w: 128, h: 188, name: '4×6판' },
  '46bae': { w: 188, h: 257, name: '4×6배판' },
  kuk: { w: 148, h: 210, name: '국판(A5)' },
  crown: { w: 176, h: 248, name: '크라운판' },
  b5: { w: 182, h: 257, name: 'B5' },
  a4: { w: 210, h: 297, name: 'A4' },
  pocket: { w: 105, h: 148, name: '문고판(A6)' },
};

// ── 그림 기초 ──
function toGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114;
  return g;
}
// 글씨용 회색: 색 글씨(빨강·주황·파랑)는 밝기만 보면 흐려서 인식이 안 된다 → 어두운 색일수록 가장 어두운 색 성분 쪽으로
//  (밝은 바탕색·형광펜은 그대로 밝게 둔다)
function toInkGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    const r = rgba[j], gg = rgba[j + 1], b = rgba[j + 2], lum = r * 0.299 + gg * 0.587 + b * 0.114;
    if (lum >= 200) { g[i] = lum; continue; }
    // 색이 짙은(채도 높은) 점만: 조명 색이 낀 종이·옅은 바탕색은 채도가 낮아 그대로 둔다
    const mn = Math.min(r, gg, b), sat = Math.max(r, gg, b) - mn;
    if (sat <= 60 || lum > 0.74 * (sat + mn)) { g[i] = lum; continue; }   // 노랑(형광펜)은 밝기가 가장 센 성분에 가깝다 → 바탕으로 둔다
    g[i] = lum - (lum - mn) * Math.min(1, (sat - 60) / 60) * Math.min(1, (200 - lum) / 40);
  }
  return g;
}
function shrink(g, w, h, f) {
  const W = Math.max(1, Math.floor(w / f)), H = Math.max(1, Math.floor(h / f)), o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let yy = y * f; yy < (y + 1) * f && yy < h; yy++) for (let xx = x * f; xx < (x + 1) * f && xx < w; xx++) { s += g[yy * w + xx]; n++; }
    o[y * W + x] = s / n;
  }
  return { g: o, w: W, h: H };
}
function otsu(g) {
  const hist = new Float64Array(256);
  for (const v of g) hist[Math.max(0, Math.min(255, v | 0))]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = g.length - wB; if (!wF) break;
    sB += i * hist[i];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}

// 사진 속 종이(밝은 덩어리)의 네 모서리
function findPage(g, w, h, rgba = null, mode = 'bright') {
  const f = Math.max(1, Math.round(Math.max(w, h) / 500));
  const s = shrink(g, w, h, f);
  // 두 번 나눈다: 어두운 것(표지·그늘) / 나머지 → 나머지 안에서 책상(나무) / 종이
  let t = otsu(s.g);
  const upper = s.g.filter(v => v > t);
  if (upper.length > s.g.length * 0.75) {   // 밝은 쪽이 너무 넓으면(책상과 종이가 한 덩어리) 한 번 더 나눈다
    const t2 = otsu(upper);
    const lo = upper.filter(v => v <= t2), hi = upper.filter(v => v > t2);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    if (hi.length > s.g.length * 0.12 && mean(hi) - mean(lo) > 22) t = t2;
  }
  let on = new Uint8Array(s.w * s.h);
  if (mode === 'table' && rgba) {
    // 책상 색(사진 가장자리 띠의 가운데 값)과 색이 다른 곳 = 책(색 있는 쪽·짙은 머리띠도 함께 잡힌다)
    const C = new Float32Array(s.w * s.h * 3);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      const k = (Math.min(h - 1, y * f + (f >> 1)) * w + Math.min(w - 1, x * f + (f >> 1))) * 4, o = (y * s.w + x) * 3;
      C[o] = rgba[k]; C[o + 1] = rgba[k + 1]; C[o + 2] = rgba[k + 2];
    }
    const ring = [], bw = Math.max(2, Math.round(Math.min(s.w, s.h) * 0.04));
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (y < bw || y >= s.h - bw || x < bw || x >= s.w - bw) ring.push(y * s.w + x);
    const med = [0, 1, 2].map(c => median(ring.map(i => C[i * 3 + c])));
    const d = new Float32Array(s.w * s.h);
    for (let i = 0; i < d.length; i++) d[i] = Math.min(255, Math.hypot(C[i * 3] - med[0], C[i * 3 + 1] - med[1], C[i * 3 + 2] - med[2]) * 2);
    const td = Math.max(24, otsu(d));
    // 살색(손)·갈색(표지 날개, 나무)은 책 종이가 아니다: 빨강>초록>파랑 순으로 뚜렷이 벌어진 색은 뺀다
    for (let i = 0; i < on.length; i++) { const r = C[i * 3], gg = C[i * 3 + 1], bb = C[i * 3 + 2]; on[i] = d[i] > td && !(r - gg >= 12 && r - bb >= 35 && gg >= bb) ? 1 : 0; }
    // 작은 구멍(글씨·그림 속 책상색과 비슷한 점)을 메운다: 줄마다 양 끝 사이를 채우지 않고 3×3 닫기
    const cl = new Uint8Array(on.length);
    for (let y = 1; y < s.h - 1; y++) for (let x = 1; x < s.w - 1; x++) { let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += on[(y + dy) * s.w + x + dx]; cl[y * s.w + x] = n >= 4 ? 1 : 0; }
    on = cl;
  } else for (let i = 0; i < on.length; i++) on[i] = s.g[i] > t ? 1 : 0;
  // 가늘게 이어진 밝은 것(키보드·흰 상자)과 떨어지도록 한 번 깎는다
  const er = new Uint8Array(on.length);
  for (let y = 1; y < s.h - 1; y++) for (let x = 1; x < s.w - 1; x++) {
    const i = y * s.w + x;
    er[i] = on[i] && on[i - 1] && on[i + 1] && on[i - s.w] && on[i + s.w] ? 1 : 0;
  }
  on = er;
  // 가장 큰 밝은 덩어리
  const lab = new Int32Array(on.length).fill(-1);
  let best = -1, bestN = 0, id = 0;
  const stack = [], sizes = [];
  for (let i = 0; i < on.length; i++) {
    if (!on[i] || lab[i] >= 0) continue;
    let n = 0; stack.push(i); lab[i] = id;
    while (stack.length) {
      const k = stack.pop(); n++;
      const x = k % s.w, y = (k / s.w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= s.w || Y >= s.h) continue;
        const q = Y * s.w + X;
        if (on[q] && lab[q] < 0) { lab[q] = id; stack.push(q); }
      }
    }
    sizes.push(n);
    if (n > bestN) { bestN = n; best = id; }
    id++;
  }
  // 펼친 책의 가운데 접힌 그늘이 짙으면 두 쪽이 따로 떨어진 덩어리가 된다 → 옆에 붙은 비슷한 크기의 덩어리를 한 장으로 합친다
  const keep = new Set([best]);
  {
    const bb = new Map();
    for (let i = 0; i < lab.length; i++) {
      const L = lab[i]; if (L < 0 || sizes[L] < bestN * 0.4) continue;
      const x = i % s.w, y = (i / s.w) | 0;
      const b = bb.get(L) || { x0: x, x1: x, y0: y, y1: y }; b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y); bb.set(L, b);
    }
    const B = bb.get(best);
    for (const [L, b] of bb) {
      if (L === best) continue;
      const vo = Math.min(b.y1, B.y1) - Math.max(b.y0, B.y0), hgap = Math.max(b.x0 - B.x1, B.x0 - b.x1);
      if (vo > 0.6 * Math.min(b.y1 - b.y0, B.y1 - B.y0) && hgap < 0.12 * (B.x1 - B.x0) && (b.y1 - b.y0) > (b.x1 - b.x0) * 0.9) { keep.add(L); bestN += sizes[L]; }
    }
  }
  const frac = bestN / on.length;
  const whole = [[0, 0], [w, 0], [w, h], [0, h]];
  if (frac < 0.2 || frac > 0.97) return { quad: whole, found: false };
  // 덩어리의 모서리: 덩어리 테두리를 감싸는 볼록 껍질 위에서 넓이가 가장 큰 네 점(손·책상 귀퉁이가 끼어도 비틀린 사각형이 되지 않게)
  const rowL = new Float64Array(s.h).fill(Infinity), rowR = new Float64Array(s.h).fill(-Infinity);
  for (let i = 0; i < lab.length; i++) {
    if (!keep.has(lab[i])) continue;
    const x = i % s.w, y = (i / s.w) | 0;
    if (x < rowL[y]) rowL[y] = x; if (x + 1 > rowR[y]) rowR[y] = x + 1;
  }
  const pts = [];
  for (let y = 0; y < s.h; y++) if (rowL[y] < Infinity) { pts.push([rowL[y], y + 0.5]); pts.push([rowR[y], y + 0.5]); }
  const hull = convexHull(pts);
  let tl, tr, br, bl;
  {
    // 껍질 점을 줄여(최대 120개) 네 점 고르기
    const H = hull.length > 120 ? hull.filter((_, k) => k % Math.ceil(hull.length / 120) === 0) : hull;
    const n = H.length;
    const area = (a, b, c, d) => Math.abs((a[0] * b[1] - b[0] * a[1]) + (b[0] * c[1] - c[0] * b[1]) + (c[0] * d[1] - d[0] * c[1]) + (d[0] * a[1] - a[0] * d[1])) / 2;
    let bestA = -1, Q = null;
    if (n >= 4) {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        // i,j를 대각선으로: 양쪽에서 가장 먼 점(볼록이라 각 쪽 하나씩)
        let k1 = -1, d1 = -1, k2 = -1, d2 = -1;
        const ax = H[j][0] - H[i][0], ay = H[j][1] - H[i][1];
        for (let k = i + 1; k < j; k++) { const d = Math.abs(ax * (H[k][1] - H[i][1]) - ay * (H[k][0] - H[i][0])); if (d > d1) { d1 = d; k1 = k; } }
        for (let k = j + 1; k < n + i; k++) { const kk = k % n; const d = Math.abs(ax * (H[kk][1] - H[i][1]) - ay * (H[kk][0] - H[i][0])); if (d > d2) { d2 = d; k2 = kk; } }
        if (k1 < 0 || k2 < 0) continue;
        const A = area(H[i], H[k1], H[j], H[k2]);
        if (A > bestA) { bestA = A; Q = [H[i], H[k1], H[j], H[k2]]; }
      }
    }
    if (!Q) return { quad: whole, found: false };
    // 네 변을 따로 곧은 줄로 맞춘다(손·책상 귀퉁이처럼 한 변의 일부만 튀어나온 것은 따돌린다)
    try {
      const sideFit = robustSides(lab, keep, s.w, s.h);
      if (sideFit) Q = sideFit;
    } catch {}
    // 네 점을 왼쪽 위·오른쪽 위·오른쪽 아래·왼쪽 아래 순으로
    const cx = Q.reduce((a, p) => a + p[0], 0) / 4, cy = Q.reduce((a, p) => a + p[1], 0) / 4;
    Q.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));   // −π(왼쪽)부터 시계 방향(화면 좌표)
    let k0 = 0, m = Infinity; Q.forEach((p, k) => { if (p[0] + p[1] < m) { m = p[0] + p[1]; k0 = k; } });
    [tl, tr, br, bl] = [0, 1, 2, 3].map(k => Q[(k0 + k) % 4]);
  }
  // 종이 가장자리가 사진 테두리에 닿으면(바짝 찍은 사진) 그 모서리는 사진 모서리로
  const quad = [tl, tr, br, bl].map(([x, y]) => [x * f, y * f]);
  // 예전 방식 모서리(x±y 가 가장 큰/작은 점)도 후보로 함께 돌려준다
  let c0 = [0, 0, Infinity], c2 = [0, 0, -Infinity], c1 = [0, 0, -Infinity], c3 = [0, 0, Infinity];
  for (let i = 0; i < lab.length; i++) {
    if (!keep.has(lab[i])) continue;
    const x = i % s.w + 0.5, y = ((i / s.w) | 0) + 0.5;
    if (x + y < c0[2]) c0 = [x, y, x + y]; if (x + y > c2[2]) c2 = [x, y, x + y];
    if (x - y > c1[2]) c1 = [x, y, x - y]; if (x - y < c3[2]) c3 = [x, y, x - y];
  }
  const corner = [c0, c1, c2, c3].map(([x, y]) => [x * f, y * f]);
  return { quad, found: true, frac, corner };
}

// 쪽 찾기 후보 둘(밝은 종이 / 책상과 다른 색) 가운데 글씨를 더 많이 담으면서 군더더기가 적은 쪽
function findPageBest(g, w, h, rgba) {
  const whole = { quad: [[0, 0], [w, 0], [w, h], [0, h]], found: false };
  const L = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const sane = (r) => {
    if (!r.found) return false;
    const q = r.quad, pw = (L(q[0], q[1]) + L(q[3], q[2])) / 2, ph = (L(q[0], q[3]) + L(q[1], q[2])) / 2;
    const ar = Math.abs(q.reduce((a, p, i) => { const n = q[(i + 1) % 4]; return a + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;
    // 위에서 찍은 책이면 마주 보는 변이 거의 나란하다(위아래 변까지 크게 벌어지면 손·다른 물건에 끌린 것)
    const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    const dAng = (x, y) => { let d = Math.abs(x - y) % 180; return d > 90 ? 180 - d : d; };
    const d1 = dAng(ang(q[0], q[1]), ang(q[3], q[2])), d2 = dAng(ang(q[0], q[3]), ang(q[1], q[2]));
    if (globalThis.__pageDbg) (globalThis.__angDbg ||= []).push([+d1.toFixed(1), +d2.toFixed(1)]);
    // 아주 낮게 찍어 옆변이 더 벌어진 것(27°~34°)은 '넓은 각'으로 표시해 두고, 글씨를 거의 다 담을 때만 쓴다
    if (d1 > 6.2 || d2 > 34 || (d2 > 27 && d1 > 3)) return false;
    r.wide = d2 > 27;
    // 넓은 각인데 꼭짓점 셋 이상이 사진 가장자리에 붙었으면 쪽이 아니라 사진 귀퉁이를 따라간 것이다
    if (r.wide && q.filter(p => p[0] < w * 0.015 || p[0] > w * 0.985 || p[1] < h * 0.015 || p[1] > h * 0.985).length >= 3) return false;   // 낮게 비스듬히 찍으면 옆변만 벌어진다(사다리꼴) — 그건 받아들인다
    return pw / ph > 0.4 && pw / ph < 2.4 && ar > w * h * 0.15 && Math.min(L(q[0], q[1]), L(q[3], q[2])) > Math.max(L(q[0], q[1]), L(q[3], q[2])) * 0.55 && Math.min(L(q[0], q[3]), L(q[1], q[2])) > Math.max(L(q[0], q[3]), L(q[1], q[2])) * 0.55;
  };
  let A = findPage(g, w, h, rgba, 'bright');
  const dbg = globalThis.process?.env?.PGDBG, pq = (r) => r.found ? r.quad.map(p => p.map(v => Math.round(v / w * 100)).join(',')).join(' ') : 'none';
  if (dbg) { globalThis.__angDbg = []; console.error('PG A', pq(A), 'sane', sane(A), JSON.stringify(globalThis.__angDbg)); }
  if (!sane(A)) A = whole;
  if (globalThis.__pageDbg) globalThis.__pageScore = null;
  if (!rgba) return A;
  let B; try { B = findPage(g, w, h, rgba, 'table'); } catch { return A; }
  if (dbg) { globalThis.__angDbg = []; console.error('PG B', pq(B), 'sane', sane(B), JSON.stringify(globalThis.__angDbg)); }
  if (!sane(B)) B = whole;
  if (A === whole && B === whole) return whole;
  if (A !== whole && !A.corner) A.corner = null;
  // 글씨 점: 주변보다 뚜렷이 어두운 작은 점(1/4 크기에서)
  const f = Math.max(1, Math.round(Math.max(w, h) / 800)), s = shrink(g, w, h, f);
  const ink = [];
  const R = 6, I = new Float64Array((s.w + 1) * (s.h + 1));
  for (let y = 0; y < s.h; y++) { let r = 0; for (let x = 0; x < s.w; x++) { r += s.g[y * s.w + x]; I[(y + 1) * (s.w + 1) + x + 1] = I[y * (s.w + 1) + x + 1] + r; } }
  for (let y = R; y < s.h - R; y += 2) for (let x = R; x < s.w - R; x += 2) {
    const sum = I[(y + R + 1) * (s.w + 1) + x + R + 1] - I[(y - R) * (s.w + 1) + x + R + 1] - I[(y + R + 1) * (s.w + 1) + x - R] + I[(y - R) * (s.w + 1) + x - R];
    const m = sum / ((2 * R + 1) ** 2), v = s.g[y * s.w + x];
    if (m > 165 && v < m - 40) ink.push([x * f, y * f]);
  }
  // 글줄에 놓인 점만 남긴다(손 주름·책 옆면 줄무늬·그림 테두리는 가로로 길게 늘어서지 않는다)
  {
    const cw = Math.ceil(w / (f * 2)), chh = Math.ceil(h / (f * 2)), grid = new Uint8Array(cw * chh);
    for (const [x, y] of ink) grid[Math.round(y / (f * 2)) * cw + Math.round(x / (f * 2))] = 1;
    const keepPt = ([x, y]) => {
      const gx = Math.round(x / (f * 2)), gy = Math.round(y / (f * 2)); let hz = 0, vt = 0;
      for (let d = -12; d <= 12; d++) { if (gx + d >= 0 && gx + d < cw && (grid[gy * cw + gx + d] || (gy > 0 && grid[(gy - 1) * cw + gx + d]) || (gy + 1 < chh && grid[(gy + 1) * cw + gx + d]))) hz++; if (gy + d >= 0 && gy + d < chh && grid[(gy + d) * cw + gx]) vt++; }
      return hz >= 9 && vt <= 16;
    };
    const t = ink.filter(keepPt);
    if (t.length >= 200) { ink.length = 0; for (const q of t) ink.push(q); }
  }
  if (ink.length < 200) return A;
  const inside = (q, p) => { let c = false; for (let i = 0, j = 3; i < 4; j = i++) { const [xi, yi] = q[i], [xj, yj] = q[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c; } return c; };
  const area = (q) => Math.abs(q.reduce((a, p, i) => { const n = q[(i + 1) % 4]; return a + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;
  const score = (r) => { const n = ink.filter(p => inside(r.quad, p)).length / ink.length; return n - 0.5 * area(r.quad) / (w * h); };
  // 글씨를 가장 많이 담는 것(조금 덜 담는 것까지)을 고르고, 그중 가장 작은(군더더기 없는) 사각형
  const cands = [whole];
  if (A.corner) { const C0 = { quad: A.corner, found: true }; if (sane(C0)) cands.push(C0); }   // 예전 방식이 먼저(넓이가 거의 같으면 이것)
  cands.push(A, B);
  const cov = (r) => ink.filter(p => inside(r.quad, p)).length / ink.length;
  const sc = cands.map(r => ({ r, n: cov(r), a: area(r.quad) / (w * h) }));
  // 사진 전체는 책상 위 다른 책 글씨까지 담으므로, 찾은 사각형들이 전체 글씨의 대부분을 못 담을 때만 쓴다
  const found = sc.filter(c => c.r !== whole && c.r.found && (!c.r.wide || c.n >= sc[0].n * 0.95));
  const maxN = found.length ? Math.max(...found.map(c => c.n)) : 0;
  if (dbg) console.error('PG cov', sc.map(c => (c.r === whole ? 'whole' : c.r === A ? 'A' : c.r === B ? 'B' : 'corner') + ' n=' + c.n.toFixed(2) + ' a=' + c.a.toFixed(2)).join(' | '), 'ink', ink.length);
  if (!found.length || maxN < sc[0].n * 0.8) return whole;
  const ok = found.filter(c => c.n >= maxN - 0.015).sort((x, y) => (Math.abs(x.a - y.a) < 0.015 ? 0 : x.a - y.a));
  if (globalThis.__pageDbg) globalThis.__pageScore = { cov: sc.map(c => +c.n.toFixed(3)), area: sc.map(c => +c.a.toFixed(2)) };
  return ok[0].r;
}
// 덩어리의 위·아래·왼쪽·오른쪽 가장자리를 각각 곧은 줄로(RANSAC), 네 줄이 만나는 네 점
function robustSides(lab, keep, W, H) {
  const top = [], bot = [], left = [], right = [];
  const cT = new Float64Array(W).fill(Infinity), cB = new Float64Array(W).fill(-Infinity), rL = new Float64Array(H).fill(Infinity), rR = new Float64Array(H).fill(-Infinity);
  for (let i = 0; i < lab.length; i++) {
    if (!keep.has(lab[i])) continue;
    const x = i % W, y = (i / W) | 0;
    if (y < cT[x]) cT[x] = y; if (y > cB[x]) cB[x] = y; if (x < rL[y]) rL[y] = x; if (x > rR[y]) rR[y] = x;
  }
  for (let x = 0; x < W; x++) if (cT[x] < Infinity) { top.push([x, cT[x]]); bot.push([x, cB[x] + 1]); }
  for (let y = 0; y < H; y++) if (rL[y] < Infinity) { left.push([y, rL[y]]); right.push([y, rR[y] + 1]); }
  if (top.length < 20 || left.length < 20) return null;
  // v = a·u + b, 바깥쪽(sign) 방향으로 안쪽 점들을 감싸도록
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;   // 같은 사진은 늘 같은 결과가 나오게
  const fit = (P, sign, tol) => {
    const n = P.length; let best = null, bestN = -1;
    // 가장자리 10% 는 귀퉁이가 둥글어 빼고 고른다
    const lo = Math.floor(n * 0.08), hi = Math.ceil(n * 0.92);
    for (let it = 0; it < 300; it++) {
      const i = lo + ((rnd() * (hi - lo)) | 0), j = lo + ((rnd() * (hi - lo)) | 0);
      if (Math.abs(P[i][0] - P[j][0]) < (P[hi - 1][0] - P[lo][0]) * 0.25) continue;
      const a = (P[j][1] - P[i][1]) / (P[j][0] - P[i][0]); if (Math.abs(a) > 0.6) continue;
      const b = P[i][1] - a * P[i][0];
      let c = 0; for (let k = lo; k < hi; k++) if (Math.abs(P[k][1] - a * P[k][0] - b) < tol) c++;
      if (c > bestN) { bestN = c; best = [a, b]; }
    }
    if (!best || bestN < (hi - lo) * 0.3) return null;
    // 잘 맞는 점으로 다시 맞추고(최소제곱), 그 점들의 바깥 끝까지 밀어 낸다
    const inl = P.slice(lo, hi).filter(p => Math.abs(p[1] - best[0] * p[0] - best[1]) < tol);
    const mu = inl.reduce((s, p) => s + p[0], 0) / inl.length, mv = inl.reduce((s, p) => s + p[1], 0) / inl.length;
    let sxx = 0, sxy = 0; for (const p of inl) { sxx += (p[0] - mu) ** 2; sxy += (p[0] - mu) * (p[1] - mv); }
    const a = sxx > 0 ? sxy / sxx : 0; let b = mv - a * mu;
    const res = inl.map(p => (p[1] - a * p[0] - b) * sign).sort((x, y) => x - y);
    b += sign * res[Math.floor(res.length * 0.97)];
    return [a, b];
  };
  const tolX = Math.max(2, W * 0.015), tolY = Math.max(2, H * 0.015);
  const T = fit(top, -1, tolY), B = fit(bot, 1, tolY), L = fit(left, -1, tolX), R = fit(right, 1, tolX);
  if (!T || !B || !L || !R) return null;
  // 가로줄 y = a x + b 와 세로줄 x = c y + d 가 만나는 점
  const meet = ([a, b], [c, d]) => { const y = (a * d + b) / (1 - a * c); return [c * y + d, y]; };
  const Q = [meet(T, L), meet(T, R), meet(B, R), meet(B, L)];
  if (Q.some(([x, y]) => !isFinite(x) || !isFinite(y) || x < -W * 0.05 || y < -H * 0.05 || x > W * 1.05 || y > H * 1.05)) return null;
  return Q.map(([x, y]) => [Math.max(0, Math.min(W, x)), Math.max(0, Math.min(H, y))]);
}
function convexHull(P) {
  const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// 원근 바로잡기: 사각형(quad) → W×H 직사각형
function homography(src, dst) {
  // dst(u,v) → src(x,y) 를 푸는 8원 연립방정식
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  for (let c = 0; c < 8; c++) {
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      for (let q = c; q < 8; q++) A[r][q] -= k * A[c][q];
      b[r] -= k * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}
function warp(g, w, h, quad, W, H) {
  const m = homography(quad, [[0, 0], [W, 0], [W, H], [0, H]]);
  const o = new Uint8Array(W * H);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const d = m[6] * u + m[7] * v + 1;
    const x = (m[0] * u + m[1] * v + m[2]) / d, y = (m[3] * u + m[4] * v + m[5]) / d;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) { o[v * W + u] = 255; continue; }
    const i = y0 * w + x0;
    o[v * W + u] = g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) + g[i + w] * (1 - fx) * fy + g[i + w + 1] * fx * fy;
  }
  return o;
}
// 색 그대로(빨강·초록·파랑 세 장) 같은 사각형으로 편다 — 글씨 색, 상자 색, 그림 오려 넣기에 쓴다
function warpRGB(rgba, w, h, quad, W, H) {
  const m = homography(quad, [[0, 0], [W, 0], [W, H], [0, H]]);
  const R = new Uint8Array(W * H), G = new Uint8Array(W * H), B = new Uint8Array(W * H);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const d = m[6] * u + m[7] * v + 1;
    const x = (m[0] * u + m[1] * v + m[2]) / d, y = (m[3] * u + m[4] * v + m[5]) / d;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, k = v * W + u;
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) { R[k] = G[k] = B[k] = 255; continue; }
    const i = (y0 * w + x0) * 4, a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, e = fx * fy;
    R[k] = rgba[i] * a + rgba[i + 4] * b + rgba[i + w * 4] * c + rgba[i + w * 4 + 4] * e;
    G[k] = rgba[i + 1] * a + rgba[i + 5] * b + rgba[i + w * 4 + 1] * c + rgba[i + w * 4 + 5] * e;
    B[k] = rgba[i + 2] * a + rgba[i + 6] * b + rgba[i + w * 4 + 2] * c + rgba[i + w * 4 + 6] * e;
  }
  return [R, G, B];
}
// 조명 고르게: 종이 바탕의 밝기(글자를 지운 밝기 지도)를 구해 나눈다 (그늘·밝기 차이가 있는 사진 대비)
//  - 작은 격자에서 이웃 최댓값(글자 지우기) → 부드럽게 흐리기 → 양선형으로 키워서 나눈다
//    (격자 경계가 계단처럼 남으면 글자 인식이 그 경계를 선으로 읽으므로 반드시 매끄럽게)
// 앞장 글씨만 진하게: 종이 바탕과 글씨를 가르는 문턱(T1) 아래에서 다시 진한 앞장 글씨와 흐린 뒷장 비침을 가른다.
//  가장 진한 글씨(B)는 검정으로, 문턱 근처(W)는 흰색으로 늘려 비친 글씨·얼룩을 지우고 앞장 획을 또렷하게 한다
// 짙은 띠·상자 속 흰 글씨(장 머리띠, 번호 딱지): 그 자리만 밝기를 뒤집어 '흰 바탕에 검은 글씨'로 만든다.
//  돌려주는 값: 뒤집은 자리들 [{x0,y0,x1,y1}] (그 안의 글줄은 원본에서 흰 글씨였다)
function invertDarkRegions(o, W, H, mask = null) {
  const c = Math.max(6, Math.round(W / 220)), gw = Math.ceil(W / c), gh = Math.ceil(H / c);
  const dark = new Float32Array(gw * gh), bright = new Float32Array(gw * gh);
  // 종이 밝기: 사진 전체에서 밝은 쪽 값(P90)과, 넓은 이웃의 가장 밝은 값 가운데 큰 쪽(조명이 고르지 않아도, 띠가 커도 견디게)
  const mean = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let a = 0, n = 0;
    for (let y = gy * c; y < Math.min(H, (gy + 1) * c); y += 2) for (let x = gx * c; x < Math.min(W, (gx + 1) * c); x += 2) { a += o[y * W + x]; n++; }
    mean[gy * gw + gx] = a / Math.max(1, n);
  }
  const sorted = Float32Array.from(mean).sort(), p90 = sorted[Math.floor(sorted.length * 0.9)];
  const R = Math.max(4, Math.round(gw / 7)), tmp = new Float32Array(gw * gh), bg = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) { let m = 0; for (let d = -R; d <= R; d += 2) { const X = gx + d; if (X >= 0 && X < gw && mean[gy * gw + X] > m) m = mean[gy * gw + X]; } tmp[gy * gw + gx] = m; }
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) { let m = 0; for (let d = -R; d <= R; d += 2) { const Y = gy + d; if (Y >= 0 && Y < gh && tmp[Y * gw + gx] > m) m = tmp[Y * gw + gx]; } bg[gy * gw + gx] = Math.max(m, p90 * 0.8); }
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let d = 0, b = 0, n = 0; const ref = bg[gy * gw + gx], lo = ref * 0.55, hi = ref * 0.72;
    for (let y = gy * c; y < Math.min(H, (gy + 1) * c); y += 2) for (let x = gx * c; x < Math.min(W, (gx + 1) * c); x += 2) { const v = o[y * W + x]; if (v < lo) d++; else if (v > hi) b++; n++; }
    dark[gy * gw + gx] = d / Math.max(1, n); bright[gy * gw + gx] = b / Math.max(1, n);
  }
  // 짙은 칸(>55%)과, 짙은 칸으로 빙 둘러싸인 구멍(흰 글씨가 지나는 칸)
  const solid = new Uint8Array(gw * gh);
  for (let i = 0; i < solid.length; i++) solid[i] = dark[i] > 0.55 ? 1 : 0;
  const outside = new Uint8Array(gw * gh), st0 = [];
  const pushIf = (i) => { if (!solid[i] && !outside[i]) { outside[i] = 1; st0.push(i); } };
  for (let x = 0; x < gw; x++) { pushIf(x); pushIf((gh - 1) * gw + x); }
  for (let y = 0; y < gh; y++) { pushIf(y * gw); pushIf(y * gw + gw - 1); }
  while (st0.length) { const k = st0.pop(), x = k % gw, y = (k / gw) | 0; if (x > 0) pushIf(k - 1); if (x < gw - 1) pushIf(k + 1); if (y > 0) pushIf(k - gw); if (y < gh - 1) pushIf(k + gw); }
  const fill = new Uint8Array(gw * gh);
  for (let i = 0; i < fill.length; i++) fill[i] = solid[i] || !outside[i] ? 1 : 0;
  const lab = new Int32Array(gw * gh).fill(-1), regs = [];
  for (let i0 = 0; i0 < fill.length; i0++) {
    if (!fill[i0] || lab[i0] >= 0) continue;
    const id = regs.length, st = [i0], cells = []; lab[i0] = id;
    let x0 = gw, x1 = 0, y0 = gh, y1 = 0, br = 0, ns = 0;
    while (st.length) {
      const k = st.pop(), x = k % gw, y = (k / gw) | 0; cells.push(k); br += bright[k]; ns += solid[k];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [k - 1, k + 1, k - gw, k + gw]) { if (q < 0 || q >= fill.length || lab[q] >= 0 || !fill[q]) continue; if ((q === k - 1 && x === 0) || (q === k + 1 && x === gw - 1)) continue; lab[q] = id; st.push(q); }
    }
    regs.push({ id, cells, x0, x1, y0, y1, br: br / cells.length, ns });
  }
  const out = [];
  for (const r of regs) {
    const bw = r.x1 - r.x0 + 1, bh = r.y1 - r.y0 + 1;
    // 글줄 한 줄 높이는 넘고, 가로로 넉넉하며, 꽉 차 있고, 안에 밝은 점(흰 글씨)이 조금 있는 것. 구멍이 짙은 칸보다 많으면 테두리 상자다
    if (bh * c < H * 0.012 || bh < 3 || bw < 6 || bw < bh * 0.8) continue;   // 세로로 긴 것(책 옆면·그늘)은 띠가 아니다
    { // 비스듬한 띠도 받도록: 줄마다 왼쪽 끝~오른쪽 끝 사이가 얼마나 차 있는지로 본다
      const lo = new Int32Array(bh).fill(gw), hi = new Int32Array(bh).fill(-1);
      for (const k of r.cells) { const x = k % gw, y = ((k / gw) | 0) - r.y0; if (x < lo[y]) lo[y] = x; if (x > hi[y]) hi[y] = x; }
      let ext = 0; for (let y = 0; y < bh; y++) if (hi[y] >= 0) ext += hi[y] - lo[y] + 1;
      if (r.cells.length < ext * 0.6) continue;
    }
    if (r.br < 0.02 || r.br > 0.32 || r.cells.length - r.ns > r.ns * 0.6) continue;
    // 굵은 검은 글씨 뭉치는 띠가 아니다: 띠는 온통 짙은 칸(>90%)이 넉넉하다
    if (r.cells.filter(k => dark[k] > 0.9).length < r.cells.length * 0.3) continue;
    if (bw * bh > gw * gh * 0.6) continue;
    const inR = new Uint8Array(gw * gh); for (const k of r.cells) inR[k] = 1;
    { const dv = r.cells.filter(k => solid[k]).map(k => mean[k]).sort((p, q) => p - q); r.lvl = dv.length ? dv[dv.length >> 1] : 60; }
    const firstL = new Int32Array(c), lastR = new Int32Array(c), firstT = new Int32Array(c), lastB = new Int32Array(c);
    for (const k of r.cells) {
      const x = k % gw, y = (k / gw) | 0, ref = bg[k], paper = Math.min(255, ref), lo = ref * 0.55;
      const oL = x === 0 || !inR[k - 1], oR = x === gw - 1 || !inR[k + 1], oT = y === 0 || !inR[k - gw], oB = y === gh - 1 || !inR[k + gw];
      const X0 = x * c, Y0 = y * c, X1 = Math.min(W, X0 + c), Y1 = Math.min(H, Y0 + c);
      // 가장자리 칸: 바깥쪽에서 들어오며 처음 만나는 짙은 점부터가 띠 안이다(그 앞의 밝은 점은 띠 밖 종이)
      if (oL || oR) for (let yy = Y0; yy < Y1; yy++) { let f = c, l = -1; for (let xx = X0; xx < X1; xx++) if (o[yy * W + xx] < lo) { if (f === c) f = xx - X0; l = xx - X0; } firstL[yy - Y0] = f; lastR[yy - Y0] = l; }
      if (oT || oB) for (let xx = X0; xx < X1; xx++) { let f = c, l = -1; for (let yy = Y0; yy < Y1; yy++) if (o[yy * W + xx] < lo) { if (f === c) f = yy - Y0; l = yy - Y0; } firstT[xx - X0] = f; lastB[xx - X0] = l; }
      for (let yy = Y0; yy < Y1; yy++) for (let xx = X0; xx < X1; xx++) {
        const inside = (!oL || xx - X0 >= firstL[yy - Y0]) && (!oR || xx - X0 <= lastR[yy - Y0]) && (!oT || yy - Y0 >= firstT[xx - X0]) && (!oB || yy - Y0 <= lastB[xx - X0]);
        if (!inside) continue;
        const v = o[yy * W + xx];
        o[yy * W + xx] = Math.max(0, Math.min(paper, paper * (1 - (v - r.lvl) / Math.max(30, ref * 0.9 - r.lvl))));
        if (mask) mask[yy * W + xx] = 255;
      }
    }
    // 띠 바깥에 붙은 칸(한 칸 둘레)에 남은 짙은 테두리 찌꺼기 지우기
    for (const k of r.cells) {
      const x = k % gw, y = (k / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= gw || Y >= gh || inR[Y * gw + X] || outside[Y * gw + X] === 2) continue;
        outside[Y * gw + X] = 2;
        const pv = Math.min(255, bg[Y * gw + X]);
        for (let yy = Y * c; yy < Math.min(H, (Y + 1) * c); yy++) for (let xx = X * c; xx < Math.min(W, (X + 1) * c); xx++) if (o[yy * W + xx] < pv * 0.92) o[yy * W + xx] = pv;
      }
    }
    out.push({ x0: r.x0 * c, y0: r.y0 * c, x1: (r.x1 + 1) * c, y1: (r.y1 + 1) * c });
  }
  return out;
}
function levels(o) {
  const env = globalThis.process?.env || {};
  if (env.NOLEV) return o;
  const smp = []; for (let i = 0; i < o.length; i += 5) smp.push(o[i]);
  const T1 = otsu(smp.filter(v => v < 245));
  const ink = smp.filter(v => v < T1);
  if (ink.length < smp.length * 0.004) return o;
  const T2 = otsu(ink);
  const dark = ink.filter(v => v < T2).sort((a, b) => a - b);
  if (!dark.length) return o;
  const B = dark[Math.floor(dark.length * 0.05)];
  const W = T1 - (env.LEVW != null ? +env.LEVW : -10), gam = +env.LEVG || 1.8;
  if (W - B < 40) return o;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * Math.pow(Math.max(0, Math.min(1, (v - B) / (W - B))), gam));
  const out = new Uint8Array(o.length);
  for (let i = 0; i < o.length; i++) out[i] = lut[o[i]];
  if (o.even) out.even = true;
  return out;
}
function flatten(g, W, H) {
  const f = Math.max(4, Math.round(W / 60));
  const s = shrink(g, W, H, f);
  const mxf = (src, r) => {
    const o = new Float32Array(src.length);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      let m = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const X = Math.min(s.w - 1, Math.max(0, x + dx)), Y = Math.min(s.h - 1, Math.max(0, y + dy));
        if (src[Y * s.w + X] > m) m = src[Y * s.w + X];
      }
      o[y * s.w + x] = m;
    }
    return o;
  };
  const blur = (src) => {
    const o = new Float32Array(src.length);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      let a = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= s.w || Y >= s.h) continue;
        a += src[Y * s.w + X]; n++;
      }
      o[y * s.w + x] = a / n;
    }
    return o;
  };
  const mx1 = mxf(s.g, 1);
  // 밝기가 고른 쪽(스캔·평판)은 예전처럼 칸별 최댓값으로 나눈다 — 글자 인식 결과가 검증된 방식 그대로
  {
    const v = Array.from(mx1).sort((p, q) => p - q), pc = (t) => v[Math.min(v.length - 1, Math.floor(v.length * t))];
    if (pc(0.95) - pc(0.05) < 18) {
      const o = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const bx = Math.min(s.w - 1, (x / f) | 0), by = Math.min(s.h - 1, (y / f) | 0);
        o[y * W + x] = Math.max(0, Math.min(255, (g[y * W + x] / Math.max(60, mx1[by * s.w + bx])) * 245));
      }
      o.even = true;   // 고른 밝기 = 스캔·평판일 가능성이 크다
      return o;
    }
  }
  let bg = blur(blur(mx1));
  const o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(s.h - 1, Math.max(0, y / f - 0.5)), y0 = Math.floor(fy), y1 = Math.min(s.h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(s.w - 1, Math.max(0, x / f - 0.5)), x0 = Math.floor(fx), x1 = Math.min(s.w - 1, x0 + 1), tx = fx - x0;
      const b = (bg[y0 * s.w + x0] * (1 - tx) + bg[y0 * s.w + x1] * tx) * (1 - ty) + (bg[y1 * s.w + x0] * (1 - tx) + bg[y1 * s.w + x1] * tx) * ty;
      o[y * W + x] = Math.max(0, Math.min(255, (g[y * W + x] / Math.max(60, b)) * 245));
    }
  }
  return o;
}
const grayPng = (g, W, H) => {
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < g.length; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = g[i];
  return encodePng(W, H, 2, rgb);
};

// 펼친 두 쪽(가로로 긴 사진)이면 가운데 글자 없는 골에서 나눈다
// 가로 줄(제목 위아래 선 같은 장식선): 글줄이 아닌 자리에서 판면 폭의 3할 넘게 이어진 가는 검은 줄
function findRules(g, W, H, lines) {
  const hs = lines.map(l => l.y1 - l.y0).sort((a, b) => a - b), hMed = hs[hs.length >> 1] || 30;
  const busy = (y) => lines.some(l => y > l.y0 - hMed * 0.15 && y < l.y1 + hMed * 0.15 && (l.x1 - l.x0) > hMed * 1.5);
  const rows = [];
  for (let y = 2; y < H - 2; y++) {
    if (busy(y)) continue;
    let best = 0, b0 = 0, run = 0, r0 = 0;
    for (let x = 0; x < W; x++) {
      const d = g[y * W + x] < 120 || g[(y - 1) * W + x] < 120 || g[(y + 1) * W + x] < 120 || g[(y - 2) * W + x] < 120 || g[(y + 2) * W + x] < 120;   // 살짝 기운 줄도
      if (d) { if (!run) r0 = x; run++; if (run > best) { best = run; b0 = r0; } } else run = 0;
    }
    if (best > W * 0.3) rows.push({ y, x0: b0, x1: b0 + best });
  }
  // 이어진 행끼리 묶어 한 줄로(두께가 글자보다 훨씬 얇아야 선)
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && r.y - last.y1 <= 2) { last.y1 = r.y; last.x0 = Math.min(last.x0, r.x0); last.x1 = Math.max(last.x1, r.x1); }
    else out.push({ y0: r.y, y1: r.y, x0: r.x0, x1: r.x1 });
  }
  return out.filter(r => r.y1 - r.y0 <= hMed * 0.25).map(r => ({ x0: r.x0, x1: r.x1, y: (r.y0 + r.y1) / 2, t: Math.max(1, r.y1 - r.y0 - 1) }));
}

function splitSpread(g, W, H, raw = null) {
  // 비스듬히 찍은 펼친 책은 펴 놓은 사각형이 세로로 길어 보일 수 있다 → 0.7~0.95 는 가운데 그늘이 뚜렷할 때만 가른다
  if (W / H < 0.7) return [{ x0: 0, x1: W }];
  const narrow = W / H < 0.95;
  const ink = new Float32Array(W);
  for (let x = 0; x < W; x++) { let n = 0; for (let y = 0; y < H; y += 2) if (g[y * W + x] < 140) n++; ink[x] = n; }
  // 1) 가운데 접힌 곳은 그늘이 진다: 밝기 고르기 전 사진에서 세로줄 평균 밝기가 가장 어두운 골짜기(가운데 근처)
  if (raw) {
    const col = new Float32Array(W);
    // 세로줄마다 밝은 쪽(위에서 20% 자리) 값 = 그 줄의 종이 밝기. 평균을 쓰면 색 상자·글씨에 끌려 엉뚱한 곳을 골짜기로 본다
    { const hist = new Uint16Array(256), y0 = Math.round(H * 0.05), y1 = Math.round(H * 0.95), cnt = Math.ceil((y1 - y0) / 3);
      for (let x = 0; x < W; x++) { hist.fill(0); for (let y = y0; y < y1; y += 3) hist[raw[y * W + x]]++; let acc = 0, v = 255; for (; v > 0; v--) { acc += hist[v]; if (acc >= cnt * 0.2) break; } col[x] = v; } }
    const sm = new Float32Array(W), r = Math.max(2, Math.round(W * 0.004));
    for (let x = 0; x < W; x++) { let a = 0, n = 0; for (let k = -r; k <= r; k++) { const q = x + k; if (q >= 0 && q < W) { a += col[q]; n++; } } sm[x] = a / n; }
    let bx = -1, bv = Infinity;
    for (let x = Math.round(W * 0.4); x < W * 0.6; x++) if (sm[x] < bv) { bv = sm[x]; bx = x; }
    const side = (a, b) => { const v = []; for (let x = Math.round(a); x < b; x++) v.push(sm[x]); v.sort((p, q) => p - q); return v[v.length >> 1]; };
    const around = Math.min(side(bx - W * 0.12, bx - W * 0.04), side(bx + W * 0.04, bx + W * 0.12));
    if (globalThis.__koDbg) console.error('GUTTER', bx, Math.round(bv), Math.round(around), ink[bx]);
    if (bx > 0 && around - bv > Math.max(8, around * 0.06) && (ink[bx] <= H * 0.01 || around - bv > 25 || W / H > 1.15)) return [{ x0: 0, x1: bx }, { x0: bx, x1: W }];
  }
  if (narrow) return [{ x0: 0, x1: W }];
  let bestX = -1, bestRun = 0;
  for (let x = Math.round(W * 0.35); x < W * 0.65;) {
    if (ink[x] > H * 0.004) { x++; continue; }
    let e = x; while (e < W * 0.65 && ink[e] <= H * 0.004) e++;
    if (e - x > bestRun) { bestRun = e - x; bestX = (x + e) >> 1; }
    x = e + 1;
  }
  if (globalThis.__koDbg) console.error('SPLIT', W, H, bestX, bestRun, Array.from({ length: 30 }, (_, i) => Math.round(ink[Math.round(W * (0.35 + i * 0.01))])).join(','));
  if (bestX < 0) return W / H > 1.2 ? [{ x0: 0, x1: W >> 1 }, { x0: W >> 1, x1: W }] : [{ x0: 0, x1: W }];   // 누가 봐도 펼친 두 쪽이면 가운데서
  return [{ x0: 0, x1: bestX }, { x0: bestX, x1: W }];
}

// 휜 쪽 펴기: 세로 띠마다 글줄 위치(가로 투영)를 가운데 띠와 맞춰 보아 위아래 어긋남을 재고,
// 위·가운데·아래 세 구역의 어긋남을 이어 붙여 줄이 곧게 되도록 다시 그린다.
function dewarp(g, W, H, extra = null) {
  const N = 14, sw = W / N, bands = 3, bh = H / bands;
  const prof = (x0, x1, y0, y1) => {
    const p = new Float32Array(y1 - y0);
    for (let y = y0; y < y1; y++) { let n = 0; for (let x = x0; x < x1; x += 2) if (g[y * W + x] < 150) n++; p[y - y0] = n; }
    return p;
  };
  const maxShift = Math.round(H * 0.03);
  const off = [];   // off[b][i] : 띠 i, 구역 b 의 위아래 어긋남(화소)
  let any = false;
  for (let b = 0; b < bands; b++) {
    const y0 = Math.round(b * bh), y1 = Math.round((b + 1) * bh);
    const ref = prof(Math.round(W / 2 - sw), Math.round(W / 2 + sw), y0, y1);
    const row = [];
    let prev = 0;
    // 가운데에서 바깥으로 이웃 띠와 차례로 맞춘다
    const shifts = new Array(N).fill(0);
    const c = Math.floor(N / 2);
    for (const dir of [1, -1]) {
      prev = 0; let refP = ref;
      for (let i = dir > 0 ? c : c - 1; i >= 0 && i < N; i += dir) {
        const p = prof(Math.round(i * sw), Math.round((i + 1) * sw), y0, y1);
        let best = prev, bestS = -Infinity;
        for (let d = prev - 12; d <= prev + 12; d++) {
          if (Math.abs(d) > maxShift) continue;
          let sum = 0;
          for (let y = 20; y < refP.length - 20; y++) { const q = y + d - prev; if (q >= 0 && q < p.length) sum += refP[y] * p[q]; }
          if (sum > bestS) { bestS = sum; best = d; }
        }
        if (bestS <= 0) best = prev;
        shifts[i] = best; prev = best; refP = p;
        if (best) any = true;
      }
    }
    // 튀는 값 누르기(이웃 평균)
    for (let i = 0; i < N; i++) row.push((shifts[Math.max(0, i - 1)] + 2 * shifts[i] + shifts[Math.min(N - 1, i + 1)]) / 4);
    off.push(row);
  }
  if (!any) return g;
  const apply = (g, fill) => {
    const o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const fb = Math.min(bands - 1, Math.max(0, y / bh - 0.5));
      const b0 = Math.floor(fb), b1 = Math.min(bands - 1, b0 + 1), tb = fb - b0;
      for (let x = 0; x < W; x++) {
        const fi = Math.min(N - 1, Math.max(0, x / sw - 0.5));
        const i0 = Math.floor(fi), i1 = Math.min(N - 1, i0 + 1), ti = fi - i0;
        const d0 = off[b0][i0] * (1 - ti) + off[b0][i1] * ti, d1 = off[b1][i0] * (1 - ti) + off[b1][i1] * ti;
        const sy = y + d0 * (1 - tb) + d1 * tb;
        const y0 = Math.floor(sy), f = sy - y0;
        o[y * W + x] = y0 < 0 || y0 >= H - 1 ? fill : g[y0 * W + x] * (1 - f) + g[(y0 + 1) * W + x] * f;
      }
    }
    return o;
  };
  if (extra) for (let k = 0; k < extra.length; k++) extra[k] = apply(extra[k], k === 3 ? 0 : 255);   // [빨강, 초록, 파랑, 뒤집은 자리]
  return apply(g, 255);
}

// 회색으로 칠한 상자(메모 칸·글상자) 찾기: 종이(흰색)보다 어둡고 글자보다 밝은 넓은 덩어리
export function findBoxes(g, W, H) {
  const f = 4, w = Math.floor(W / f), h = Math.floor(H / f);
  const m = new Uint8Array(w * h), val = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += g[(y * f + dy) * W + x * f + dx];
    const v = s / (f * f); val[y * w + x] = v;
  }
  // 조명 고르기: 종이 밝기를 2차 곡면으로 맞춘다(회색 상자·글자는 빼면서 세 번 다시 맞춤) → 그 곡면 대비 어두운 정도로 판단
  const fit = (keep) => {
    const A = Array.from({ length: 6 }, () => new Float64Array(6)), B = new Float64Array(6);
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = y * w + x; if (!keep(i)) continue;
      const u = x / w - 0.5, v = y / h - 0.5, t = [1, u, v, u * u, v * v, u * v];
      for (let a = 0; a < 6; a++) { B[a] += t[a] * val[i]; for (let b = 0; b < 6; b++) A[a][b] += t[a] * t[b]; }
    }
    for (let c = 0; c < 6; c++) {
      let p2 = c; for (let r = c + 1; r < 6; r++) if (Math.abs(A[r][c]) > Math.abs(A[p2][c])) p2 = r;
      [A[c], A[p2]] = [A[p2], A[c]]; [B[c], B[p2]] = [B[p2], B[c]];
      if (Math.abs(A[c][c]) < 1e-9) return null;
      for (let r = 0; r < 6; r++) { if (r === c) continue; const k = A[r][c] / A[c][c]; for (let q = c; q < 6; q++) A[r][q] -= k * A[c][q]; B[r] -= k * B[c]; }
    }
    const co = B.map((b, i) => b / A[i][i]);
    return (x, y) => { const u = x / w - 0.5, v = y / h - 0.5; return co[0] + co[1] * u + co[2] * v + co[3] * u * u + co[4] * v * v + co[5] * u * v; };
  };
  const sorted = Float32Array.from(val).sort();
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 230;
  let bg = fit(i => val[i] > p90 * 0.9);
  for (let it = 0; it < 3 && bg; it++) { const prev = bg; bg = fit(i => { const x = i % w, y = (i / w) | 0; return val[i] > prev(x, y) * 0.95; }) || prev; }
  if (!bg) return [];
  const rel = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rel[y * w + x] = val[y * w + x] / Math.max(40, bg(x, y));
  for (let i = 0; i < val.length; i++) m[i] = rel[i] > 0.6 && rel[i] < 0.94 ? 1 : 0;
  const paper = 1;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (m[i] && (Math.abs(rel[i] - rel[i - 1]) > 0.1 || Math.abs(rel[i] - rel[i - w]) > 0.1)) m[i] = 0;
  }
  for (let i = 0; i < val.length; i++) val[i] = rel[i];
  // 줄마다 가장 긴 회색 구간을 찾고, 왼쪽·오른쪽 끝이 나란한 줄들이 이어지면 상자로 본다
  // (페이지 아래쪽 그늘처럼 끝이 들쭉날쭉하거나 종이 끝까지 닿는 것은 빠진다)
  const runs = [];
  for (let y = 0; y < h; y++) {
    let best = null, xs = -1, gap = 0;
    for (let x = 0; x <= w; x++) {
      const on = x < w && m[y * w + x];
      if (on) { if (xs < 0) xs = x; gap = 0; }
      else if (xs >= 0 && (++gap > 2 || x === w)) {
        const xe = x - gap; if (!best || xe - xs > best[1] - best[0]) best = [xs, xe]; xs = -1; gap = 0;
      }
    }
    runs.push(best && best[1] - best[0] >= w * 0.3 ? best : null);
  }
  const boxes = [];
  for (let y = 0; y < h;) {
    if (!runs[y]) { y++; continue; }
    let y2 = y, [xs, xe] = runs[y], n = 0, sum = 0;
    const tol = Math.max(3, w * 0.015);
    while (y2 + 1 < h && runs[y2 + 1] && Math.abs(runs[y2 + 1][0] - xs) <= tol && Math.abs(runs[y2 + 1][1] - xe) <= tol) y2++;
    const bh = y2 - y + 1;
    if (bh >= h * 0.035 && xs > w * 0.04 && xe < w * 0.96 && y > h * 0.01 && y2 < h * 0.99) {
      // 둥근 모서리: 맨 위·아래 줄이 가운데 줄보다 짧으면
      const mid = runs[(y + y2) >> 1];
      const round = runs[y][1] - runs[y][0] < (mid[1] - mid[0]) - 2 || runs[y2][1] - runs[y2][0] < (mid[1] - mid[0]) - 2;
      for (let yy = y; yy <= y2; yy++) for (let x = runs[yy][0]; x < runs[yy][1]; x++) { sum += val[yy * w + x]; n++; }
      const gray = Math.round(Math.min(255, (sum / Math.max(1, n)) * 255));
      const hex = gray.toString(16).padStart(2, '0');
      boxes.push({ x0: xs * f, y0: y * f, x1: (xe + 1) * f, y1: (y2 + 1) * f, fill: hex + hex + hex, round });
    }
    y = y2 + 1;
  }
  // 위아래로 붙은 조각 합치기
  boxes.sort((p, q) => p.y0 - q.y0);
  for (let i = 1; i < boxes.length; i++) {
    const p = boxes[i - 1], q = boxes[i];
    if (q.y0 - p.y1 <= f * 3 && Math.abs(q.x0 - p.x0) < W * 0.04 && Math.abs(q.x1 - p.x1) < W * 0.04) {
      boxes[i - 1] = { ...p, x0: Math.min(p.x0, q.x0), x1: Math.max(p.x1, q.x1), y1: q.y1, round: p.round || q.round };
      boxes.splice(i--, 1);
    }
  }
  // 모서리가 각지고 쪽 가장자리에 닿은 회색 = 쪽 바탕(책상·그늘·색 종이)이지 상자가 아니다
  return boxes.filter(b => b.round || (b.x0 > W * 0.07 && b.x1 < W * 0.93 && b.y1 < H * 0.95));
}

// ── 사진 한 장 → 펴진 쪽 그림들 ──
export function rectifyPhoto(img) {
  const g = toGray(img.data, img.w, img.h);
  // 쪽 찾기는 늘 같은 크기(긴 변 2576)에서 한다 — 사진 크기에 따라 결과가 달라지지 않게(휴대폰 원본은 더 크다). 펴기·글자 읽기는 원래 크기로.
  let quad, found;
  const fsc = Math.max(img.w, img.h) / 2576;
  if (fsc > 1.12) {   // 스캔본(긴 변 2900 이하)은 그대로
    const sw = Math.round(img.w / fsc), sh = Math.round(img.h / fsc), sd = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) {
      const ya = Math.floor(y * fsc), yb = Math.min(img.h, Math.max(ya + 1, Math.floor((y + 1) * fsc)));
      for (let x = 0; x < sw; x++) {
        const xa = Math.floor(x * fsc), xb = Math.min(img.w, Math.max(xa + 1, Math.floor((x + 1) * fsc)));
        let r = 0, gg = 0, bb = 0, n = 0;
        for (let Y = ya; Y < yb; Y++) for (let X = xa; X < xb; X++) { const i = (Y * img.w + X) * 4; r += img.data[i]; gg += img.data[i + 1]; bb += img.data[i + 2]; n++; }
        const o = (y * sw + x) * 4; sd[o] = r / n; sd[o + 1] = gg / n; sd[o + 2] = bb / n; sd[o + 3] = 255;
      }
    }
    const r = findPageBest(toGray(sd, sw, sh), sw, sh, sd);
    found = r.found; quad = r.quad.map(q => [Math.min(img.w - 1, q[0] * fsc), Math.min(img.h - 1, q[1] * fsc)]);
  } else ({ quad, found } = findPageBest(g, img.w, img.h, img.data));
  if (globalThis.__pageDbg) globalThis.__pageDbg.push({ quad, found, w: img.w, h: img.h, sc: globalThis.__pageScore });
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const pw = (len(quad[0], quad[1]) + len(quad[3], quad[2])) / 2;
  const ph = (len(quad[0], quad[3]) + len(quad[1], quad[2])) / 2;
  // 글자 인식이 잘 되도록 한 쪽 가로를 1700~2400 화소로
  const spread = pw / ph > 0.7;
  const scale = Math.min(3, Math.max(1, (spread ? 3400 : 1800) / pw));
  const W = Math.round(pw * scale), H = Math.round(ph * scale);
  const raw = warp(globalThis.process?.env?.NOINK ? g : toInkGray(img.data, img.w, img.h), img.w, img.h, quad, W, H);
  // 짙은 색 바탕에 흰 글씨(색 바탕 장 표지 등): 바탕이 어두우면 밝기를 뒤집어 '흰 종이에 검은 글씨'로
  let invAll = false;
  {
    const smp = []; for (let y = Math.round(H * 0.1); y < H * 0.9; y += 7) for (let x = Math.round(W * 0.05); x < W * 0.95; x += 7) smp.push(raw[y * W + x]);
    smp.sort((a, b) => a - b);
    const med = smp[smp.length >> 1], hi = smp[Math.floor(smp.length * 0.97)];
    if (med < 135 && hi - med > 60 && smp[Math.floor(smp.length * 0.7)] < 150) { invAll = true; for (let i = 0; i < raw.length; i++) raw[i] = 255 - raw[i]; }
  }
  // 짙은 띠 속 흰 글씨는 밝기 고르기 전에 뒤집어 둔다(고르기가 넓은 짙은 띠를 얼룩지게 만든다)
  let darkRegs = [], rawInk = raw;
  const invMask = new Uint8Array(W * H);
  if (!globalThis.process?.env?.NODARK) { try { rawInk = new Uint8Array(raw); darkRegs = invertDarkRegions(rawInk, W, H, invMask); } catch { darkRegs = []; rawInk = raw; invMask.fill(0); } }
  const rgb = warpRGB(img.data, img.w, img.h, quad, W, H);
  const flat0 = flatten(rawInk, W, H);
  const parts = splitSpread(flat0, W, H, raw);   // 가운데 접힌 그늘은 밝기 조절 전 그림에서 찾는다
  if (globalThis.__pageDbg) globalThis.__splitDbg = { W, H, parts, raw };
  const flat = flat0.even ? flat0 : levels(flat0);   // 앞장 글씨만 진하게(뒷장 비침 지우기)는 사진에만 — 스캔은 이미 고르다
  return parts.map(({ x0, x1 }, pi) => {
    const side = parts.length === 2 ? (pi === 0 ? 'L' : 'R') : null;
    const w = x1 - x0, out = new Uint8Array(w * H), rawPart = new Uint8Array(w * H);
    for (let y = 0; y < H; y++) { out.set(flat.subarray(y * W + x0, y * W + x1), y * w); rawPart.set(raw.subarray(y * W + x0, y * W + x1), y * w); }
    // 색 세 장 + 뒤집은 자리 표시도 같은 자리로 오려 두고, 아래의 펴기·바로 세우기를 똑같이 따라 한다
    const planes = [...rgb, invMask].map(src => { const o = new Uint8Array(w * H); for (let y = 0; y < H; y++) o.set(src.subarray(y * W + x0, y * W + x1), y * w); return o; });
    // 휜 종이 펴기: 입체 종이 모형으로 먼저 해 보고, 글줄이 모자라 못 하면 예전 방식(띠 맞추기)
    let sheet = null;
    try { sheet = sheetDewarpMap(out, w, H); } catch { sheet = null; }
    // 거의 평평한 쪽(스캔·평판)은 그대로 두고, 실제로 휜 쪽만 편다
    if (sheet && sheet.rms < 3 && sheet.curvature >= 0.03 && sheet.rmsFlat > Math.max(2.5, sheet.rms * 1.8) && sheet.outW > w * 0.6 && sheet.outW < w * 1.5) {
      const g2 = applyDewarpMap(out, w, H, sheet);
      for (let k = 0; k < planes.length; k++) planes[k] = applyDewarpMap(planes[k], w, H, sheet, k === 3 ? 0 : 255);
      // 회색 상자: 펴기 전 그림에서 찾고(이 때가 가장 잘 찾아진다), 네 귀·변 가운데를 편 그림 좌표로 옮긴다
      const boxes = findBoxes(rawPart, w, H).map(b => {
        const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1], [(b.x0 + b.x1) / 2, b.y0], [(b.x0 + b.x1) / 2, b.y1], [b.x0, (b.y0 + b.y1) / 2], [b.x1, (b.y0 + b.y1) / 2]].map(([x, y]) => invertPoint(sheet, x, y));
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        // 휜 변은 가운데가 더 안쪽/바깥쪽 → 귀퉁이 기준 사각형
        return { ...b, x0: (pts[0][0] + pts[2][0]) / 2, x1: (pts[1][0] + pts[3][0]) / 2, y0: Math.min(pts[0][1], pts[1][1], pts[4][1]), y1: Math.max(pts[2][1], pts[3][1], pts[5][1]) };
      }).filter(b => b.x1 - b.x0 > 20 && b.y1 - b.y0 > 20);
      return straighten({ even: flat.even, g: g2, w: sheet.outW, h: sheet.outH, pageFound: found, spread, side, boxes, planes, invAll, sheet: { rms: sheet.rms, rmsFlat: sheet.rmsFlat, curvature: sheet.curvature, spans: sheet.spans } });
    }
    const g2 = dewarp(out, w, H, planes);
    // 회색 상자는 밝기 고르기 전 그림에서 찾는다 (고르기가 넓은 회색을 흰색으로 지워 버리므로)
    return straighten({ even: flat.even, g: g2, w, h: H, pageFound: found, spread, side, planes, invAll, boxes: findBoxes(rawPart, w, H) });
  });
}
// 비스듬히 찍어 판면이 사다리꼴이면 좌우 가장자리를 세로로 바로 세운다
function straighten(part) {
  let M = null;
  if (part.even || globalThis.process?.env?.NOSTRAIGHT) return part;   // 스캔한 쪽은 이미 반듯하다 (본문 속 짧은 줄·행간 번역 칸에 속아 기울이지 않게)
  try { M = marginMap(part.g, part.w, part.h); } catch { M = null; }
  if (!M) return part;
  // 판면 밖(쪽 번호·꼬리말)이 바로 세우며 그림 밖으로 밀려 잘리지 않게 양옆을 넓혀 둔다
  const pad = Math.ceil(Math.max(Math.abs(M.Lf.b), Math.abs(M.Rf.b)) * part.h * 0.6) + 8;
  M.L0 += pad; M.R0 += pad;
  const W2 = part.w + pad * 2;
  const g = applyMarginMap(part.g, part.w, part.h, M, 255, W2);
  const planes = part.planes ? part.planes.map((pl, k) => applyMarginMap(pl, part.w, part.h, M, k === 3 ? 0 : 255, W2)) : null;
  const boxes = part.boxes.map(b => {
    const xa = marginInvX(M, b.x0, b.y0), xb = marginInvX(M, b.x0, b.y1), xc = marginInvX(M, b.x1, b.y0), xd = marginInvX(M, b.x1, b.y1);
    return { ...b, x0: (xa + xb) / 2, x1: (xc + xd) / 2 };
  });
  return { ...part, g, w: W2, boxes, planes, margins: { left: M.Lf.b, right: M.Rf.b } };
}

// ── 글자 폭 (내보낼 글꼴 기준, em 단위) ──
function adv(ch, font) {
  if (ch === ' ') return HWP_SPACE;
  const c = ch.codePointAt(0);
  if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f) || (c >= 0x4e00 && c <= 0x9fff)) return HANGUL_ADVANCE[font] ?? 1;
  if ((c >= 0x0300 && c <= 0x036f) || (c >= 0x0591 && c <= 0x05c7 && c !== 0x05be && c !== 0x05c3 && c !== 0x05c0)) return 0;   // 얹는 부호(악센트·모음 부호)는 폭이 없다
  if (c >= 0x05d0 && c <= 0x05ea) return 0.6;
  if (/[“”‘’「」『』《》〈〉…·]/.test(ch)) return /[…]/.test(ch) ? 1 : 0.5;
  if (/[.,:;!?'"()[\]]/.test(ch)) return 0.3;
  if (/[0-9]/.test(ch)) return 0.55;
  if (/[A-Z]/.test(ch)) return 0.68;
  return 0.5;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))] : 0; };
const hangulish = (t) => /[가-힣]/.test(t);

// OCR 결과 다듬기: 한글 사이에 잘못 낀 빈칸, 흔한 오인식
const isHebrew = t => /[\u05D0-\u05EA]/.test(t) && !/[A-Za-z\uAC00-\uD7A3\u0370-\u03FF]/.test(t);
function cleanText(t) {
  t = t.replace(/(^|[^가-힣A-Za-z])&(?=월)/g, '$18');   // &월 → 8월
  t = t.replace(/[\uFF21-\uFF3A\uFF41-\uFF5A\uFF10-\uFF19]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));   // 전각 영문·숫자(Ｌ) → 보통 글자
  t = t.replace(/([가-힣])ㆍ(?=[가-힣])/g, '$1·');   // 아래아 모양 가운뎃점 → 가운뎃점
  t = t.replace(/^(\d{1,2}),(?=\s*[가-힣])/, '$1.');   // 3, 환란을 → 3. 환란을 (제목 번호)
  t = t.replace(/(^|\s)ㅣ(?=\s|$)/g, '$1|');   // 따로 선 'ㅣ'는 세로줄(꼬리말 구분선)
  return t.replace(/\s+/g, ' ').replace(/ ?([.,!?」』”’)]) ?/g, (m, p) => p + ' ').replace(/ ([.,!?])/g, '$1').trim();
}

// ── 쪽들의 줄 → 판형·글자 모양 측정 ──
// 사진마다 화소 크기가 달라서, 쪽마다 따로 재고(화소) pt로 바꾼 뒤 가운값을 쓴다.
export function measurePages(pages, opts = {}) {
  const font = opts.font || '함초롬바탕';
  // 1) 줄 다듬기: 줄 높이·바닥선은 낱말 상자들의 가운값
  for (const p of pages) {
    p.lines = p.lines.map(l => ({ ...l, text: cleanText(l.text) })).filter(l => l.text && (l.text.replace(/\s/g, '').length >= 2 || /\d/.test(l.text)) && l.y1 > l.y0);
    for (const l of p.lines) {
      const ws = (l.words || []).filter(w => w.y1 > w.y0 && /[가-힣A-Za-z0-9]/.test(w.text));
      const big = ws.filter(w => hangulish(w.text) && w.text.length >= 2);
      const use = big.length >= 2 ? big : ws;
      l.h = use.length ? (big.length >= 2 ? pct(use.map(w => w.y1 - w.y0), 0.3) : median(use.map(w => w.y1 - w.y0))) : l.y1 - l.y0;   // 잡티가 붙어 키 큰 상자 몇 개에 끌려가지 않게(제목은 모든 글자가 크다)
      l.base = use.length ? median(use.map(w => w.y1)) : l.y1;
    }
    // 글이 아닌 것(손가락·책 모서리를 글로 잘못 읽은 것): 너무 키 큰 줄
    const hm = median(p.lines.map(l => l.h));
    const ext = (l) => { const ws = (l.words || []).filter(w => /[가-힣A-Za-z0-9]/.test(w.text) && (w.y1 - w.y0) < (l.h || 1e9) * 2.5); return ws.length ? Math.max(...ws.map(w => w.y1)) - Math.min(...ws.map(w => w.y0)) : l.y1 - l.y0; };   // 기호(세로줄 |) 상자는 빼고 잰 줄 높이
    p.lines = p.lines.filter(l => l.h < hm * 2.6 && ext(l) < hm * 4
      && /[가-힣A-Za-z0-9\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(l.text)        // 기호(|·-)뿐인 줄은 버린다
      && !(l.h < hm * 0.55 && l.text.replace(/\s/g, '').length >= 10                   // 아주 납작한 긴 줄 = 무늬·얼룩을 글로 읽은 것
           && !((l.y0 > p.h * 0.82 || l.y1 < p.h * 0.15) && (l.text.match(/[가-힣]/g) || []).length >= 4 && /\d/.test(l.text))));   // (작은 글씨 꼬리말·머리말은 둔다)
    // 줄 끝의 잡티: 책 안쪽(제본)·손가락·옆 쪽 글자가 줄 앞뒤에 한두 글자 붙어 읽힌 것
    //  - 본문과 한 글자 넘게 떨어진 짧은(1~2자)·흐린 조각, 자모·기호만 있는 조각을 줄 앞뒤에서 떼어 낸다
    const junkTok = (w) => {
      const t = w.text.trim(), syl = (t.match(/[가-힣]/g) || []).length;
      if (/^\d+[.,)]?$/.test(t) && (w.conf ?? 100) >= 50 && !w._far) return false;   // 번호(2. 3, 1) 등)는 둔다 — 아주 멀리 떨어진 숫자는 잡티
      if (/[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(t)) return false;   // 원어(헬라어·히브리어)는 둔다
      if (/^[A-Za-z][A-Za-z'’.,;:-]+$/.test(t) && (w.conf ?? 100) >= 70) return false;   // 영어 낱말
      return t.length <= 2 || !syl || (w.conf ?? 100) < 45;
    };
    const markOnly = /^[|\-–~_=\\/ㄱ-ㅎㅏ-ㅣ]+$/;
    const longs = p.lines.filter(l => l.text.replace(/\s/g, '').length >= 15);
    const colLeft = longs.length ? median(longs.map(l => l.x0)) : -Infinity, colRight = longs.length ? median(longs.map(l => l.x1)) : Infinity;
    for (const l of p.lines) {
      let ws = (l.words || []).filter(w => w.text.trim()).sort((a, b) => a.x0 - b.x0);
      if (ws.length < 2) continue;
      const n0 = ws.length;
      // 쪽 맨 위·아래 작은 글씨(머리말·꼬리말)는 글자를 띄어 짜서 조각 사이가 넓다 → 기호만 떼고 글자 조각은 두기
      const edgeLine = (l.y0 > p.h * 0.82 || l.y1 < p.h * 0.15) && (l.text.match(/[가-힣]/g) || []).length >= 3;
      const junkTok2 = (w) => !edgeLine && junkTok(w);
      for (let go = true; go && ws.length >= 2;) {
        go = false;
        const gh = Math.max(hm, l.h || 0);
        ws[0]._far = ws[0].x1 < colLeft - hm * 1.5;   // 판면 왼쪽 끝보다 한참 바깥
        if (markOnly.test(ws[0].text.trim()) || /^[」』)\]]+$/.test(ws[0].text.trim()) || (ws[1].x0 - ws[0].x1 > gh * 1.0 && (edgeLine ? /^[가-힣]$/.test(ws[0].text.trim()) && ws[1].x0 - ws[0].x1 > gh * 2.5 : junkTok2(ws[0])))) { ws.shift(); go = true; continue; }
        const a = ws[ws.length - 2], z = ws[ws.length - 1];
        z._far = z.x0 > colRight + hm * 1.5;
        if (markOnly.test(z.text.trim()) || /^[「『(\[]+$/.test(z.text.trim()) || (z.x0 - a.x1 > gh * 1.6 && junkTok2(z))) { ws.pop(); go = true; }
      }
      if (ws.length !== n0) {
        l.words = ws; l.x0 = Math.min(...ws.map(w => w.x0)); l.x1 = Math.max(...ws.map(w => w.x1));
        l.y0 = Math.min(...ws.map(w => w.y0)); l.y1 = Math.max(...ws.map(w => w.y1));
        l.text = cleanText(ws.map(w => w.text).join(' '));
      }
    }
    // 흐린 글자 몇 개뿐인 줄(그림·회색 상자 속 얼룩을 글로 읽은 것)은 버린다
    p.lines = p.lines.filter(l => {
      const ws = (l.words || []).filter(w => w.text.trim());
      if (!ws.length || ws.some(w => w.conf == null)) return true;
      const n = l.text.replace(/\s/g, '').length, mc = ws.reduce((a, w) => a + w.conf, 0) / ws.length;
      const keep = !(n <= 8 && mc < (/^\s*\d{1,4}\s*$/.test(l.text) ? 70 : 55));
      return keep;
    });
    p.lines.sort((x, y) => x.base - y.base);
  }
  // 2) 쪽마다: 본문 줄 높이·줄 사이·머리글·판면
  for (const p of pages) {
    const L = p.lines;
    p.hMed = median(L.map(l => l.h));
    const pit = [];
    for (let i = 1; i < L.length; i++) {
      const x = L[i - 1], y = L[i];
      if (Math.abs(x.h - p.hMed) < p.hMed * 0.25 && Math.abs(y.h - p.hMed) < p.hMed * 0.25) pit.push(y.base - x.base);
    }
    p.pitch = pct(pit.filter(v => v > p.hMed * 0.9), 0.3) || p.hMed * 1.7;
    if (L.length > 2) {
      const top = L[0], nxt = L[1];
      if ((nxt.base - top.base > p.pitch * 1.45 && [...top.text.replace(/\s/g, '')].length < 22) || top.h < p.hMed * 0.8) top.role = /^\s*\d+\s*$/.test(top.text) ? 'pageno' : 'header';
      // 아래쪽: 본문과 크게 떨어진 맨 아래 줄(들) = 꼬리말·쪽 번호
      for (let i = L.length - 1; i > 0 && i >= L.length - 3; i--) {
        const bot = L[i], prv = L[i - 1];
        if ((bot.text.match(/[0-9가-힣A-Za-z]/g) || []).length < 2 && bot.base - prv.base > p.pitch * 0.6) { bot.role = 'junk'; continue; }   // '제 |' 같은 잡티
        if (!(bot.base - prv.base > p.pitch * 1.45 || (/^\s*[-–]?\s*\d+\s*[-–]?\s*$/.test(bot.text) && bot.text.length < 8))) break;
        bot.role = /\d/.test(bot.text) && bot.text.length < 8 ? 'pageno' : 'footer';
        if (/\|/.test(bot.text)) bot.role = 'footer';
        if (i < L.length - 1 && L[i + 1].base - bot.base < p.pitch * 1.45) continue;
      }
    }
    p.body = L.filter(l => !l.role);
    p.inkMed = median(p.body.filter(l => [...l.text].length >= 20).map(l => l.ink || 0));
    // 두 단 구역이 있으면 판면 왼쪽 끝은 왼쪽 단, 오른쪽 끝은 오른쪽 단 줄들로 잰다
    const zoned = p.body.some(l => l.zone != null);
    p.bx0 = pct((zoned ? p.body.filter(l => l.zone == null || l.col === 0) : p.body).map(l => l.x0), 0.15);
    p.bx1 = pct((zoned ? p.body.filter(l => l.zone == null || l.col === 1) : p.body).map(l => l.x1), 0.85);
    p.emPx = median(p.body.filter(l => hangulish(l.text)).map(l => l.h)) / 0.97 || p.hMed;
    // 글자 사이를 띄워 양쪽 정렬한 책은 OCR이 음절마다 빈칸을 넣는다 → 낱말 상자 간격으로 빈칸을 다시 정한다
    const lineGaps = (l) => { const ws = (l.words || []).filter(w => w.text.trim()).sort((a, b) => a.x0 - b.x0); return { ws, gaps: ws.slice(1).map((w, i) => w.x0 - ws[i].x1) }; };
    const splitT = (gaps) => {
      const gs = gaps.filter(v => v > -p.emPx * 0.5 && v < p.emPx * 1.5).sort((a, b) => a - b);   // 단 사이 큰 틈은 빼고
      if (gs.length < 4) return null;
      let bestT = null, bestV = -1;
      for (let i = 1; i < gs.length; i++) {
        const lo = gs.slice(0, i), hi = gs.slice(i);
        const ml = lo.reduce((a, b) => a + b) / lo.length, mh = hi.reduce((a, b) => a + b) / hi.length;
        const v = lo.length * hi.length * (mh - ml) ** 2;
        if (v > bestV && mh - ml > p.emPx * 0.2) { bestV = v; bestT = (gs[i - 1] + gs[i]) / 2; }
      }
      return bestT;
    };
    // 쪽 전체의 문턱: 짧은 줄(대화 한 마디)은 틈이 몇 개 없어 제 문턱을 못 정하므로 이것을 쓴다
    const pageT = median(p.lines.map(l => splitT(lineGaps(l).gaps)).filter(v => v != null));
    for (const l of p.lines) {
      const { ws, gaps: rawGaps } = lineGaps(l);
      // 큰 글씨(제목) 줄은 틈도 글자 크기만큼 크다 → 본문 글자 크기로 환산해서 잰다
      const gsc = l.h > p.emPx * 1.15 ? (p.emPx * 0.97) / l.h : 1;
      const gaps = rawGaps.map(v => v * gsc);
      if (ws.length < 2) continue;
      let g0 = Math.max(0, pct(gaps, 0.2));
      // 틈 크기가 두 무리(글자 사이 / 낱말 사이)로 갈리면 그 가운데를 문턱으로 (상자 가장자리가 들쭉날쭉해도 안정적)
      {
        const own = splitT(gaps), nG = gaps.filter(v => v > -p.emPx * 0.5 && v < p.emPx * 1.5).length;
        const bestT = (nG < 8 && pageT) ? pageT : (own ?? (pageT || null));   // 틈이 몇 개 없는 짧은 줄은 쪽 전체 문턱
        if (bestT != null) g0 = Math.max(bestT, p.emPx * 0.15) - p.emPx * 0.12;
      }
      let t;
      // 한글은 글자 단위로 쪼개 읽히므로 넓은 틈만 띄어쓰기, 영어·헬라어·숫자 낱말끼리는 늘 띄운다
      const wordy = x => /[A-Za-z0-9\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]$/.test(x);
      const wordyStart = x => /^[("'‘“]?[A-Za-z0-9\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(x);
      const mkSeps = (g0) => ws.map((w, i) => { if (!i) return ''; const prev = ws[i - 1].text; return gaps[i - 1] > g0 + p.emPx * 0.12 || (wordy(prev) && wordyStart(w.text) && gaps[i - 1] > p.emPx * 0.08) ? ' ' : ''; });
      let seps = mkSeps(g0);
      // 긴 한글 줄에 빈칸이 거의 없으면(문턱을 잘못 잡음: 휜 줄은 틈이 고르지 않다) 쪽 전체 문턱으로 다시
      {
        const nH = ws.reduce((a, w) => a + (w.text.match(/[가-힣]/g) || []).length, 0), nS = seps.filter(x => x === ' ').length;
        if (nH >= 12 && nS < nH / 14 && pageT) { const g1 = Math.max(pageT, p.emPx * 0.15) - p.emPx * 0.12; if (g1 < g0) { g0 = g1; seps = mkSeps(g0); } }
      }
      // 히브리어는 오른쪽에서 왼쪽으로 읽는다: 이어진 히브리어 낱말들은 순서를 뒤집어 '읽는 순서'로 저장(한글·워드가 오른쪽부터 그려 준다)
      const toks = ws.map(w => w.text);
      for (let i = 0; i < toks.length;) {
        if (!isHebrew(toks[i])) { i++; continue; }
        let j = i; while (j + 1 < toks.length && isHebrew(toks[j + 1])) j++;
        const run = toks.slice(i, j + 1).reverse();
        for (let k = i; k <= j; k++) { toks[k] = run[k - i]; if (k > i) seps[k] = ' '; }
        i = j + 1;
      }
      t = toks.map((x, i) => seps[i] + x).join('');
      l.text = cleanText(t);
      // 맞춤법·띄어쓰기 바로잡기 (원어 줄은 건드리지 않는다)
      if (opts.fixer && !l.role && /[가-힣]{2}/.test(l.text) && !/[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(l.text)) {
        const spaceT = g0 + p.emPx * 0.12;
        const words = [];
        ws.forEach((w, i) => {
          if (!i || seps[i] === ' ') words.push({ ...w, cuts: [] });
          else { const cur = words[words.length - 1]; cur.cuts.push({ at: [...cur.text].length, gap: gaps[i - 1] }); Object.assign(cur, { text: cur.text + w.text, x1: w.x1, y0: Math.min(cur.y0, w.y0), y1: Math.max(cur.y1, w.y1), conf: Math.min(cur.conf ?? 80, w.conf ?? 80) }); }
        });
        const log = [];
        const li = p.lines.indexOf(l), near = (m) => m && Math.abs(m.x0 - l.x0) < p.emPx * 6 && Math.abs(m.base - l.base) < p.emPx * 3.5 ? m.text : '';
        const bigLine = (l.y1 - l.y0) > p.emPx * 1.45 && l.words.length <= 8;   // 큰 제목 줄: 글자 사이가 넓어 사진 빈칸을 믿을 수 없다 → 말대로
        const fixedWs = opts.fixer.fixLine(words, bigLine ? null : spacingGeo(p, p.emPx, spaceT, (() => { const sg = gaps.filter(v => v > spaceT && v < p.emPx * 1.5); return sg.length >= 2 ? median(sg) : null; })()), log, { before: near(p.lines[li - 1]), after: near(p.lines[li + 1]) });
        if (globalThis.__koDbg) console.error('KO', Math.round(spaceT), Math.round(p.emPx), JSON.stringify(words.map(w => [w.text, Math.round(w.conf ?? -1), (w.cuts || []).map(c => Math.round(c.gap))])));
        if (log.length) {
          for (const e of log) opts.fixes?.push({ page: pages.indexOf(p) + 1, ...e });
          l.words = fixedWs; l.text = cleanText(fixedWs.map(w => w.text).join(' '));
        }
      }
      // 머리말·꼬리말: 자간을 넓게 짠 글씨라 한 글자씩 떨어져 읽힌다(묵상 과 토 론을) → 말 단위로 다시 붙이고,
      //  쪽 번호 앞에 붙은 부스러기(토 12, 6상-)는 지운다
      else if ((l.role === 'header' || l.role === 'footer') && /[가-힣]{2}/.test(l.text.replace(/\s/g, ''))) {
        let t = l.text.trim();
        t = t.replace(/^[가-힣]\s+(?=\d)/, '').replace(/^\d?[가-힣]?\s*[-_~]\s*(?=[가-힣]{1,2}\s)/, '');
        if (opts.fixer) {
          const toks = t.split(/\s+/), lone = toks.filter(x => /^[가-힣]{1,2}$/.test(x)).length;
          if (lone >= 3) {
            // 숫자·부호 덩어리는 그대로 두고 한글 덩어리만 붙였다가 형태소대로 다시 띄운다
            const m = t.match(/^([^가-힣]*)(.*?)([^가-힣]*)$/);
            const core = m[2].replace(/\s+/g, '').replace(/([된한였했])나$/, '$1다');
            let nt = core;
            try { const fw = opts.fixer.fixLine([{ text: core }], null, null); const c = fw.map(w => w.text).join(' '); if ([...c.replace(/\s/g, '')].length === [...core].length) nt = c; } catch {}
            t = (m[1] + nt + m[3]).trim();
          }
        }
        t = t.replace(/^(\d{1,3}\.?)(?=[가-힣])/, '$1 ').replace(/([된한였했])나(?=\s*\d*$)/, '$1다');
        if (t !== l.text) {
          // 새 낱말마다 원래 글자 상자를 이어 붙여 준다(글자 수가 같은 뒤쪽부터 맞춘다 — 앞 부스러기를 지웠으므로)
          const ow = l.words.slice().sort((a, b) => a.x0 - b.x0), oc = [];
          for (const w of ow) { const cs = [...w.text.replace(/\s/g, '')]; cs.forEach((c, k) => oc.push({ w, x0: w.x0 + (w.x1 - w.x0) * k / cs.length, x1: w.x0 + (w.x1 - w.x0) * (k + 1) / cs.length })); }
          const toks = t.split(/\s+/).filter(Boolean), nc = toks.reduce((a, x) => a + [...x].length, 0);
          if (oc.length >= nc) {
            let ci = oc.length - nc; const nw = [];
            for (const x of toks) { const seg = oc.slice(ci, ci + [...x].length); ci += [...x].length; nw.push({ ...seg[0].w, text: x, x0: seg[0].x0, x1: seg.at(-1).x1, y0: Math.min(...seg.map(c => c.w.y0)), y1: Math.max(...seg.map(c => c.w.y1)) }); }
            l.words = nw;
          }
          l.text = cleanText(t);
        }
      }
    }
  }
  // 펼친 두 쪽의 쪽 번호는 이어진다: 오른쪽 꼬리말이 '… 51'로 또렷하면 왼쪽 꼬리말 앞의 망가진 번호(5(7_)를 50으로
  for (let i = 1; i < pages.length; i++) {
    const rf = pages[i].lines.filter(l => l.role === 'footer' || l.role === 'header').map(l => l.text.match(/(\d{1,4})\s*$/)).find(Boolean);
    if (!rf) continue;
    const n = +rf[1] - 1; if (n < 1) continue;
    for (const l of pages[i - 1].lines) {
      if (l.role !== 'footer' && l.role !== 'header') continue;
      const m = l.text.match(/^(\d[\d()|lI\[\]]{0,4})(?=\s*[_\-–]?\s*[가-힣])/);
      if (!m || m[1] === String(n) || !/[()|lI\[\]]/.test(m[1]) && Math.abs(+m[1] - n) < 1) continue;
      l.text = String(n) + l.text.slice(m[1].length);
      const w0 = l.words.slice().sort((a, b) => a.x0 - b.x0)[0];
      if (w0 && w0.text.startsWith(m[1])) w0.text = String(n) + w0.text.slice(m[1].length);
    }
  }
  // 번호 목록 맞추기: 같은 쪽의 다른 항목이 '3. '처럼 점을 찍었으면, 점이 빠진 '5 '에도 찍는다
  const dotted = pages.flatMap(p => p.lines.filter(l => !l.role && /^\d{1,2}\.\s/.test(l.text))).length;
  for (const p of pages) {
    const ls = p.lines.filter(l => !l.role);
    if (dotted >= 2)
      for (const l of ls) if (/^\d{1,2}\s+['"‘“]?[가-힣]/.test(l.text)) { l.text = l.text.replace(/^(\d{1,2})\s+/, '$1. '); if (l.words[0]) l.words[0] = { ...l.words[0], text: l.words[0].text.replace(/^(\d{1,2})$/, '$1.') }; }
  }
  const body = pages.flatMap(p => p.body);
  if (!body.length) throw Object.assign(new Error('NO_TEXT'), { code: 'NO_TEXT' });
  // 2-9) 동그라미 번호(①②③)와 절 번호(1) 2) 3)): 글자 인식은 ①을 '0', '(1', '@', '6' 같은 엉뚱한 글자로 읽는다.
  //  줄 머리에 같은 자리로 늘어선 짧은 번호 조각들을 한 무리로 보고, 대부분이 엉뚱하게 읽혔으면 동그라미 번호로 차례대로 매긴다
  {
    const CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
    const headRe = /^\s*([(（]?\s*[0-9@&©®oO○◯Θ⊙]{1,2}\s*[)）:;]?|[①-⑳])\s+(?=[가-힣0-9「“"'])/;
    const secRe = /^\s*(\d{1,2})\s*\)?\s*([가-힣][가-힣 ]{1,10})$/;
    let n = 0, lastSec = 0;
    for (const p of pages) {
      for (const l of p.body.slice().sort((a, b) => a.base - b.base)) {
        const em = p.emPx;
        // 절 제목 "N) 제목": 짧고(제목) 굵거나 큰 줄
        const sm = l.text.match(secRe);
        if (sm && [...l.text].length <= 14 && (l.h > em * 1.08 || (l.ink || 0) > (p.inkMed || 0) * 1.2)) {
          let k = +sm[1];
          if (lastSec && k !== lastSec + 1 && (k > lastSec + 3 || k < 1)) k = lastSec + 1;   // 7) 사전준비 → 1) (차례에 안 맞는 숫자)
          if (!lastSec && k > 3) k = 1;
          lastSec = k; n = 0;
          l.text = `${k}) ${sm[2].trim()}`; l._sec = true;
          continue;
        }
        const m = l.text.match(headRe);
        if (!m) continue;
        const tok = m[1].replace(/\s/g, '');
        const isCirc = /^[①-⑳]$/.test(tok);
        const junky = isCirc || !/^\d{1,2}[.)]?$/.test(tok);   // '2' 하나만이면 애매, '(2'·'@'·'0'은 동그라미를 잘못 읽은 것
        l._item = { tok, junky, x: l.x0 / em, len: m[0].length };
      }
    }
    // 무리 짓기: 쪽마다 줄 머리 자리가 비슷한(한 글자 안) 번호 줄들
    for (const p of pages) for (const l of p.body) if (l._item) l._item.x = l.x0 / p.emPx;
    const items = pages.flatMap(p => p.body.filter(l => l._item || l._sec).sort((a, b) => a.base - b.base));
    if (items.filter(l => l._item?.junky).length >= 2 && items.filter(l => l._item).length >= 3 && items.filter(l => l._item?.junky).length >= items.filter(l => l._item).length * 0.5) {
      let k = 0;
      for (const l of items) {
        if (l._sec) { k = 0; continue; }
        const d = l._item.tok.match(/\d+/)?.[0];
        const guess = (!k && d && +d >= 1 && +d <= 9 && !/^[(（]/.test(l._item.tok)) ? +d : k + 1;
        k = k ? k + 1 : guess || 1;
        l.text = CIRC[Math.min(19, k - 1)] + ' ' + l.text.slice(l._item.len);
      }
    }
    for (const p of pages) for (const l of p.body) { delete l._item; delete l._sec; }
  }
  // 3) 판형: 사용자가 고른 것, 아니면 종이 비율로 추정
  const aspect = median(pages.map(p => p.h / p.w));
  let size = BOOK_SIZES[opts.size] || null;
  if (!size) {
    const cands = Object.values(BOOK_SIZES).filter(Boolean);
    size = cands.reduce((b, c) => (Math.abs(c.h / c.w - aspect) < Math.abs(b.h / b.w - aspect) - 0.015 ? c : b), BOOK_SIZES.sinkuk);
    // 펼친 책은 종이가 휘어 비율이 틀어지므로, 크게 벗어나면 신국판으로 둔다(설정에서 고를 수 있음)
    if (Math.abs(size.h / size.w - aspect) > 0.08) size = { ...BOOK_SIZES.sinkuk, name: '신국판(추정)' };
  }
  for (const p of pages) p.pxPerPt = p.w / (size.w * MM);
  // 종이 가장자리를 잘못 잡아 책상까지 쪽으로 본 사진: 판면 폭이 쪽 폭에 비해 유난히 좁다.
  //  → 글자 크기는 믿을 만한 쪽에 맞추고(같은 책이니 글자 크기가 같다), 펼친 책의 왼쪽 쪽이면 바깥 여백을 짝 쪽에 맞춰 잘라 낸다
  {
    const ratio = (p) => (p.bx1 - p.bx0) / p.w;
    const maxR = Math.max(...pages.filter(p => p.body.length).map(ratio));
    const trusted = pages.filter(p => p.body.length && ratio(p) >= maxR * 0.85);
    const emRef = median(trusted.map(p => p.emPx / p.pxPerPt));
    for (const p of pages) {
      if (!p.body.length || trusted.includes(p) || !emRef) continue;
      p.pxPerPt = p.emPx / emRef;
      if (p.side === 'L') {
        const mate = pages[pages.indexOf(p) + 1];
        if (mate && mate.side === 'R' && trusted.includes(mate)) {
          const outerPt = (mate.w - mate.bx1) / mate.pxPerPt;      // 짝 쪽의 바깥 여백
          const dx = Math.round(p.bx0 - outerPt * p.pxPerPt);
          if (dx > 0) {
            const sh = (o) => { o.x0 -= dx; o.x1 -= dx; };
            for (const l of p.lines) { sh(l); for (const w of l.words || []) sh(w); }
            for (const b of p.boxes || []) sh(b);
            for (const r of p.rules || []) sh(r);
            p.bx0 -= dx; p.bx1 -= dx; p.w -= dx;
          }
        }
      }
      p.w = Math.min(p.w, size.w * MM * p.pxPerPt);
    }
  }
  const emPt = median((pages.filter(p => p.body.length >= 4).length ? pages.filter(p => p.body.length >= 4) : pages).map(p => p.emPx / p.pxPerPt));
  let sizePt = Math.round(emPt * 2) / 2, emScale = 1;
  // 줄 간격은 줄이 많은 쪽에서 잰다(몇 줄 없는 쪽은 문단 사이 빈 줄 때문에 줄 간격이 크게 재어진다)
  const manyL = pages.filter(p => p.body.length >= Math.max(6, Math.max(...pages.map(q => q.body.length)) * 0.5));
  const pitchPt = median((manyL.length ? manyL : pages).map(p => p.pitch / p.pxPerPt));
  const linePct = Math.round((pitchPt / emPt) * 100 / 5) * 5;
  // 4) 자간: 꽉 찬 줄의 글자들이 내보낼 글꼴로도 판면 폭을 정확히 채우도록
  const textWPt = median(pages.map(p => (p.bx1 - p.bx0) / p.pxPerPt));
  const fulls = pages.flatMap(p => p.body.filter(l => l.x0 < p.bx0 + p.emPx * 0.5 && l.x1 > p.bx1 - p.emPx * 0.7 && l.text.length > 8));
  const spacings = fulls.map(l => {
    const chars = [...l.text];
    const sum = chars.reduce((s, c) => s + adv(c, font), 0);
    return (textWPt / sizePt - sum) / Math.max(1, chars.length - 1) * 100;
  });
  let spacing = Math.max(-50, Math.min(50, Math.round(median(spacings) || 0)));
  // 글자 키로 잰 크기가 작게 나오는 글꼴(가는 고딕·작은 글씨)이 있다: 꽉 찬 줄을 채우려면 자간을 18% 넘게 벌려야 한다면
  //  자간이 아니라 글자 크기가 작게 재어진 것 → 글자 크기를 키워 자간을 3% 안팎으로 돌린다
  // 줄마다 '줄 폭 ÷ 글자 너비 합'으로 잰 글자 크기(자간 0 가정)와 글자 키로 잰 크기의 비 — 줄이 꽉 차지 않아도 잴 수 있다
  const pr = pages.flatMap(p => p.body.filter(l => [...l.text].length >= 14 && hangulish(l.text)).map(l => ((l.x1 - l.x0) / [...l.text].reduce((a, c) => a + adv(c, font), 0)) / p.emPx));
  const pitchRatio = pr.length >= 10 ? median(pr) : 1;
  if ((spacing > 18 && fulls.length >= 5) || (pitchRatio > 1.18 && pitchRatio < 1.6 && fulls.length < 5)) {
    const mAdv = median(fulls.map(l => { const ch = [...l.text]; return ch.reduce((a, c) => a + adv(c, font), 0) / ch.length; })) || 0.8;
    emScale = spacing > 18 && fulls.length >= 5 ? (mAdv + spacing / 100) / (mAdv + 0.03) : pitchRatio / 1.03;
    sizePt = Math.round(emPt * emScale * 2) / 2;
    const sp2 = fulls.map(l => { const ch = [...l.text]; return (textWPt / sizePt - ch.reduce((a, c) => a + adv(c, font), 0)) / Math.max(1, ch.length - 1) * 100; });
    spacing = Math.max(-50, Math.min(50, Math.round(median(sp2) || 0)));
  }
  const charsPerLine = Math.round(median(fulls.map(l => [...l.text].length)));
  // 5) 여백(pt): 쪽마다 재서 가운값. 펼친 책의 안쪽·바깥쪽은 왼쪽·오른쪽으로 평균
  const asc = 0.85;
  const nMax = Math.max(...pages.map(q => q.body.length));
  const fullPages = pages.filter(p => p.body.length >= 0.8 * nMax);
  const nLines = Math.round(median(fullPages.map(p => p.body.length)));
  const left = median(pages.map(p => p.bx0 / p.pxPerPt));
  const right = Math.max(5 * MM, size.w * MM - left - textWPt);
  const tops = pages.filter(p => p.body.length).map(p => (p.body[0].base - asc * p.emPx) / p.pxPerPt);
  const top = Math.max(5 * MM, Math.min(...tops));   // 제목 때문에 늦게 시작하는 쪽은 문단 앞 간격으로 내린다
  for (const p of pages) if (p.body.length) p.topOffset = Math.max(0, (p.body[0].base - asc * p.emPx) / p.pxPerPt - top);
  // 아래 여백: 가장 많이 채운 쪽의 마지막 줄까지 + 한 줄 여유가 들어가도록
  const lowest = Math.max(...pages.filter(p => p.body.length).map(p => (p.body.at(-1).base + (1 - asc) * p.emPx) / p.pxPerPt));
  // 사진 한 장이 한 쪽이므로, 마지막 줄이 다음 쪽으로 밀리지 않게 넉넉히(한 줄 높이만큼) 작게 둔다
  const bottom = Math.max(5 * MM, Math.min(size.h * MM - top - nLines * pitchPt - pitchPt * 1.2, size.h * MM - lowest - pitchPt * 2.5));
  const margin = { left, right, top, bottom };
  return {
    font, size, emPt, sizePt, emScale, linePct, spacing, charsPerLine, pitchPt,
    page: { w: size.w * MM, h: size.h * MM, ...margin },
    report: {
      bookSize: size.name, pageMm: [size.w, size.h],
      marginsMm: Object.fromEntries(Object.entries(margin).map(([k, v]) => [k, Math.round(v / MM * 10) / 10])),
      fontPt: sizePt, linePct, spacingPct: spacing, charsPerLine, linesPerPage: nLines,
    },
  };
}

// ── 측정값 + 줄 → 문단 모델 (pdf-convert 모델 형식, 단위 pt) ──
export function buildBookModel(pages, M, opts = {}) {
  const exact = opts.keepLines !== false;
  // 줄 그대로 모드: 왼쪽·오른쪽 쪽(안쪽·바깥쪽 여백이 다름)을 모두 담도록 판면을 가장 넓게 잡고, 줄마다 실제 자리에서 시작
  // 판면(글자 틀): 책은 모든 쪽의 여백이 같고, 펼친 두 쪽은 안쪽·바깥쪽 여백이 좌우로 뒤집힌다.
  //  왼쪽 쪽: 바깥 여백이 왼쪽 / 오른쪽 쪽: 안쪽 여백이 왼쪽. 쪽마다 잰 값의 가운값으로 하나의 틀을 정한다
  const pageWpt = M.page.w;
  const withBody = pages.filter(p => p.body.length);
  const outer = median(withBody.map(p => p.side === 'R' ? pageWpt - p.bx1 / p.pxPerPt : p.bx0 / p.pxPerPt));
  const inner = median(withBody.map(p => p.side === 'R' ? p.bx0 / p.pxPerPt : pageWpt - p.bx1 / p.pxPerPt));
  // 왼쪽·오른쪽 쪽 모두 같은 편집 용지(여백): 본문은 왼쪽 여백에서 바로 시작한다
  //  (사진은 책을 다 펴지 못해 안쪽 여백이 좁게 찍히므로, 펼친 두 쪽은 안쪽·바깥쪽 가운데 값으로)
  const sideM = withBody.some(p => p.side) ? (outer + inner) / 2 : median(withBody.map(q => q.bx0 / q.pxPerPt));
  const frameLeft = () => sideM;
  // 책의 들여쓰기는 0이거나 한 글자(문단 첫 줄) — 그 밖은 반 글자 단위
  const snapInd = (v) => v < 0.55 ? 0 : v < 1.6 ? 1 : Math.round(v * 2) / 2;
  const textWfr = median(withBody.map(p => (p.bx1 - p.bx0) / p.pxPerPt));
  for (const p of pages) p.frameShift = p.body.length ? frameLeft(p) - p.bx0 / p.pxPerPt : 0;   // 이 쪽 줄들을 틀에 맞추려 옮길 거리(pt)
  const exLeft = sideM;
  const exRight = Math.min(...pages.filter(p => p.body.length).map(p => p.w / p.pxPerPt - pct(p.body.map(l => l.x1), 0.97) / p.pxPerPt));
  const { font, sizePt, linePct, spacing } = M;
  const paras = [];
  const run = (text, size, sp = spacing) => ({ text, font, size: size ?? sizePt, color: '000000', bold: false, italic: false, spacing: sp });
  const notes = { headers: [], pagenos: [] };
  let cur = null;
  let sink = paras;   // 문단을 담는 곳(본문 흐름, 또는 단 구역의 칸)
  const flush = () => { if (cur) { sink.push(cur); cur = null; } };
  // 쪽 번호 맞추기: 사진들이 이어진 쪽이면 번호도 1씩 늘어난다 → 잘못 읽은 번호(1113 → 113)를 바로잡는다
  {
    const marg = pages.map(p => p.lines.filter(l => l.role && /\d/.test(l.text)));
    const groups = marg.map(ls => ls.flatMap(l => l.text.match(/\d{1,4}(?![가-힣.\d])/g) || []));   // '6장', '12.' 같은 장 번호는 빼고
    const votes = new Map();
    groups.forEach((gs, i) => { for (const d of gs) for (let a = 0; a < d.length; a++) for (let b = a + 1; b <= d.length; b++) { const v = +d.slice(a, b) - i; if (v > 0) votes.set(v, (votes.get(v) || 0) + (b - a)); } });
    let start = null, sup = 0;
    for (const [v] of votes) {
      let n = 0; groups.forEach((gs, i) => { if (gs.some(d => d.includes(String(v + i)))) n++; });
      if (n > sup || (n === sup && start != null && String(v).length > String(start).length)) { sup = n; start = v; }
    }
    if (start != null && sup >= 2) marg.forEach((ls, i) => {
      const want = String(start + i);
      for (const l of ls) {
        const m = (l.text.match(/\d{1,4}(?![가-힣.\d])/g) || []).find(d => d.includes(want) && d !== want && want.length >= d.length - 1);   // 1113 → 113 같은 한 자리 덧붙음만
        if (m) l.text = l.text.replace(m, want);
      }
    });
  }
  pages.forEach((p, pi) => {
    for (const l of p.lines) if (l.role === 'header' || l.role === 'footer') notes.headers.push(l.text); else if (l.role === 'pageno') notes.pagenos.push(l.text.trim());
    const em = p.emPx, pitch = p.pitch, k = p.pxPerPt;
    // 이 쪽의 회색 상자 → 쪽 기준 위치의 도형 (첫 문단에 붙인다)
    // 글줄을 판면 맨 위로 올린 만큼 상자·선도 함께 올린다
    const fdy = exact && (p.topOffset || 0) < (sizePt * Math.max(100, Math.round(M.pitchPt / sizePt * 100)) / 100) * 1.5 ? -(p.topOffset || 0) : 0;
    const floats = (exact ? [] : p.boxes || []).map(bx => ({ type: 'rect', x0: bx.x0 / k + (exact ? p.frameShift || 0 : 0), y0: bx.y0 / k + fdy, w: (bx.x1 - bx.x0) / k, h: (bx.y1 - bx.y0) / k, fill: bx.fill, ratio: bx.round ? 8 : 0, behind: true }));
    // 줄 간격: 책은 모든 쪽이 같은 틀(판면)이므로 쪽마다 잰 값이 아니라 책 전체 값 하나로
    const pagePct = exact ? Math.max(100, Math.round(M.pitchPt / sizePt * 100)) : linePct;
    const lineHpt = sizePt * pagePct / 100;
    let prevSize = sizePt, prevBase = null;
    // 줄 그대로 모드는 머리말·꼬리말·쪽 번호도 제자리에 넣는다 (책 모양 그대로)
    const seqAll = exact ? p.lines.filter(l => !l.role || l.role === 'header' || l.role === 'footer' || l.role === 'pageno') : p.body;
    // 두 단 구역: 구역마다 '가짜 줄' 하나로 묶어 통단 흐름에 넣고(나중에 두 칸짜리 표로), 구역 안 줄은 칸마다 따로 앉힌다
    const zoneOf = (l) => (l.zone != null && !l.role && p.zones?.[l.zone] ? l.zone : null);
    let seq = seqAll;
    if (p.zones?.length && seqAll.some(l => zoneOf(l) != null)) {
      if (exact) {
        const zl = new Map();
        for (const l of seqAll) { const z = zoneOf(l); if (z != null) { if (!zl.has(z)) zl.set(z, []); zl.get(z).push(l); } }
        const pseudo = [...zl.entries()].map(([zi, ls]) => ({ _zone: zi, lines: ls, y0: Math.min(...ls.map(l => l.y0)), y1: Math.max(...ls.map(l => l.y1)), x0: Math.min(...ls.map(l => l.x0)), x1: Math.max(...ls.map(l => l.x1)), g0: p.zones[zi].g0, g1: p.zones[zi].g1, text: '', words: [] }));
        for (const z of pseudo) { z.base = z.y1; z.h = z.y1 - z.y0; }
        seq = [...seqAll.filter(l => zoneOf(l) == null), ...pseudo].sort((a, b) => (a._zone != null ? a.y0 : a.base) - (b._zone != null ? b.y0 : b.base));
      } else {
        // 이어 쓰기 모드: 읽는 순서(왼쪽 단을 다 읽고 오른쪽 단)
        const key = (l) => { const z = zoneOf(l); return z == null ? [l.base, 0, 0] : [p.zones[z].y0, l.col + 1, l.base]; };
        seq = seqAll.slice().sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
      }
    }
    // 가로 줄은 바로 아래(없으면 위) 글줄에 붙여 두고, 쪽을 다 앉힌 뒤 그 글줄 자리에서 같은 거리만큼 떨어뜨려 긋는다
    const ruleAt = new Map();
    // 회색 상자도 사진의 절대 자리 대신 바로 위 글줄(없으면 아래 글줄)에서 떨어진 거리로 놓는다(글줄을 판면 틀에 맞춰 옮기므로)
    if (exact) for (const bx of p.boxes || []) {
      const above = seq.filter(l => l.y1 <= bx.y0 + p.emPx * 0.3 && !l.role).sort((a, b) => b.y1 - a.y1)[0], below = seq.filter(l => l.y0 >= bx.y0).sort((a, b) => a.y0 - b.y0)[0];
      const anc = above || below; if (!anc) continue;
      const item = { type: 'rect', dy: (bx.y0 - anc.y0) / k, x0: bx.x0 / k + (p.frameShift || 0), w: (bx.x1 - bx.x0) / k, h: (bx.y1 - bx.y0) / k, fill: bx.fill, ratio: bx.round ? 8 : 0 };
      if (!ruleAt.has(anc)) ruleAt.set(anc, []); ruleAt.get(anc).push(item);
    }
    // 그림도 같은 방식: 바로 위 글줄(없으면 아래 글줄)에 붙여 떠 있는 그림으로 놓는다
    const loosePics = [];
    if (exact) for (const pc of p.pics || []) {
      const above = seq.filter(l => (l._zone != null ? l.y0 : l.y1) <= pc.y0 + p.emPx * 0.3 && !l.role).sort((a, b) => b.y0 - a.y0)[0], below = seq.filter(l => l.y0 >= pc.y0).sort((a, b) => a.y0 - b.y0)[0];
      const anc = above || below;
      const item = { type: 'pic', x0: pc.x0 / k + (p.frameShift || 0), w: (pc.x1 - pc.x0) / k, h: (pc.y1 - pc.y0) / k, data: pc.data, ext: pc.ext, mime: pc.mime, pxW: pc.pxW, pxH: pc.pxH, behind: !!pc.behind };
      if (!anc) { loosePics.push({ ...item, y0: pc.y0 / k }); continue; }
      item.dy = (pc.y0 - anc.y0) / k;
      if (!ruleAt.has(anc)) ruleAt.set(anc, []); ruleAt.get(anc).push(item);
    }
    if (exact) for (const r of p.rules || []) {
      const below = seq.filter(l => l.y0 > r.y).sort((a, b) => a.y0 - b.y0)[0], above = seq.filter(l => l.y1 < r.y).sort((a, b) => b.y1 - a.y1)[0];
      const anc = above || below; if (!anc) continue;   // 위 글줄 기준(아래로 떨어진 거리) — 맨 위 선만 아래 글줄 기준
      const full = (r.x1 - r.x0) > (p.bx1 - p.bx0) * 0.45;
      const item = { dy: (r.y - anc.y0) / k, x1: full ? sideM : r.x0 / k + (p.frameShift || 0), x2: full ? sideM + textWfr : r.x1 / k + (p.frameShift || 0), w: Math.max(0.5, r.t / k) };
      if (!ruleAt.has(anc)) ruleAt.set(anc, []); ruleAt.get(anc).push(item);
    }
    const layoutLines = (seq, C) => {
    let prevSize = sizePt, prevBase = null;
    seq.forEach((l, li) => {
      if (l._zone != null) {
        // 두 단 구역 → 테두리 없는 두 칸짜리 표(칸마다 그 단의 줄들을 줄 그대로)
        flush();
        const z = l, gm = (z.g0 + z.g1) / 2;
        const colsL = [0, 1].map(ci => z.lines.filter(q => q.col === ci).sort((a, b) => a.base - b.base));
        const cx0 = colsL.map((ls, ci) => ls.length ? pct(ls.map(q => q.x0), 0.15) : (ci ? gm : p.bx0));
        const cx1 = colsL.map((ls, ci) => ls.length ? pct(ls.map(q => q.x1), 0.9) : (ci ? p.bx1 : gm));
        const tx0 = Math.min(cx0[0], p.bx0), tx1 = Math.max(cx1[1], p.bx1), split = (cx1[0] + cx0[1]) / 2;
        const wPt = [(split - tx0) / k, (tx1 - split) / k];
        const pad = [Math.max(0, (cx0[0] - tx0) / k), Math.max(0, (cx0[1] - split) / k)];
        const cells = colsL.map((ls, ci) => {
          const arr = [], save = sink; sink = arr;
          layoutLines(ls, { x0: cx0[ci], x1: cx1[ci], wPt: (cx1[ci] - cx0[ci]) / k, cellPt: wPt[ci] - pad[ci], y0: z.y0 });
          flush(); sink = save;
          return arr;
        });
        const hPt = (z.y1 - z.y0) / k;
        const tBefore = prevBase == null ? 0 : Math.max(0, (z.y0 - prevBase) / k - prevSize * (pagePct / 100 - 0.85));
        sink.push({
          k: 'tbl', cols: wPt, rows: [hPt], left: Math.max(0, tx0 / k + (p.frameShift || 0) - exLeft), before: tBefore,
          cells: cells.map((cp, ci) => ({ row: 0, col: ci, colSpan: 1, rowSpan: 1, borders: {}, fill: null, vAlign: 'top', mar: { top: 0, bottom: 0, left: pad[ci], right: 0 }, paras: cp })),
          pageBreak: li === 0 && pi > 0 && opts.pageBreaks !== false, hardBreak: true, align: 'LEFT', right: 0, indent: 0, size: hPt, pct: 100, runs: [],
          _rules: ruleAt.get(l) || null,
        });
        prevBase = z.y1; prevSize = 0;
        return;
      }
      const BX0 = C ? C.x0 : p.bx0, BX1 = C ? C.x1 : p.bx1;
      // 줄 머리 기준: 휜 종이·원근으로 판면 왼쪽 끝이 위아래로 조금씩 비스듬하므로, 이웃한 본문 줄들의 왼쪽 끝(가운값)을 기준으로 잰다
      const near = p.body.filter(q => Math.abs(q.base - l.base) < p.pitch * 4.5 && (q.zone ?? -1) === (l.zone ?? -1) && (C ? q.col === l.col : true));
      const nb = near.filter(q => [...q.text].length >= (M.charsPerLine || 30) * 0.8);   // 꽉 찬 줄들
      const localX0 = nb.length >= 3 ? pct(nb.map(q => q.x0), 0.3) : near.length >= 3 ? pct(near.map(q => q.x0), 0.2) : BX0;
      const indent = (l.x0 - (Math.abs(localX0 - BX0) < em * 1.2 ? localX0 : BX0)) / em;
      const localX1 = nb.length >= 3 ? pct(nb.map(q => q.x1), 0.7) : BX1;
      const rightGap = ((Math.abs(localX1 - BX1) < em * 1.5 ? localX1 : BX1) - l.x1) / em;
      const big = l.h > em * 0.97 * 1.25 && [...l.text].length < (M.charsPerLine || 40) * 0.75;
      const centered = indent > 1.5 && Math.abs(indent - rightGap) < 1.2;
      // 줄마다 글자 크기: 본문과 12% 넘게 다르면(제목·성경 구절·인용) 그 크기로
      const own = Math.round(l.h / 0.97 / k * (M.emScale || 1) * 2) / 2;
      const longLine = [...l.text].length >= (M.charsPerLine || 40) * 0.75;   // 꽉 찬 긴 줄은 본문 크기(사진 휨으로 키가 커 보이는 것 막기)
      // 문단 끝 짧은 줄(앞 줄이 꽉 찬 본문 줄, 같은 자리에서 시작)은 본문 크기 그대로
      const prevL = li > 0 ? seq[li - 1] : null;
      const tail = prevL && [...prevL.text].length >= (M.charsPerLine || 40) * 0.75 && Math.abs(l.x0 - prevL.x0) < em * 0.6 && !centered;
      // 쪽 번호만 있는 줄: 숫자 높이는 글자 크기의 약 3/4 — 잡티가 붙어 줄 키가 부풀어도 본문보다 크게 하지 않는다
      const pnoOnly = l.role && /^\d{1,4}$/.test(l.text.trim());
      const size = pnoOnly ? Math.min(sizePt, Math.max(Math.round(sizePt * 1.4) / 2, Math.round(Math.min(...(l.words?.length ? l.words.map(w => w.y1 - w.y0) : [l.h])) / 0.75 / k * 2) / 2))
        : tail ? sizePt : !longLine && (big || Math.abs(own - sizePt) / sizePt > 0.2) ? own : longLine && own < sizePt * 0.8 ? own : sizePt;   // 책 본문은 거의 한 크기 — 사진에서 잰 높이의 작은 차이(휨·기울기)는 본문 크기로 맞춘다
      // 앞 줄과의 거리: 한글은 앞 줄 높이(글자 크기 × 줄 간격)만큼 내려가므로 남는 만큼 문단 앞 간격으로
      const gapPt = prevBase == null ? (pi === 0 ? 0 : p.topOffset || 0) : (l.base - prevBase) / k - (prevSize * pagePct / 100) - 0.85 * (size - prevSize);
      // 같은 틀: 첫 줄은 판면 맨 위(장 시작처럼 크게 내려 시작한 쪽만 그만큼), 줄 사이는 반 줄 단위로 맞춘다
      const snap = (v) => v < lineHpt * 0.45 ? 0 : Math.round(v / (lineHpt / 2)) * (lineHpt / 2);
      const before = C && li === 0 ? Math.max(0, Math.round((l.y0 - C.y0) / k * 2) / 2)
        : li === 0 ? (exact ? ((p.topOffset || 0) < lineHpt * 1.5 ? 0 : snap(p.topOffset)) : (p.topOffset || 0))
        : exact && !l.role ? snap(Math.max(0, gapPt)) : Math.max(0, gapPt);
      const pageStart = !C && li === 0 && pi > 0 && opts.pageBreaks !== false;
      if (exact) {
        // 줄 하나 = 문단 하나. 꽉 찬 줄은 배분 정렬로 판면 폭을 정확히 채운다 → 줄마다 원본과 같은 글자
        // 줄마다 자간: 이 줄의 글자들이 원본 줄 폭을 정확히 채우도록 (줄 바뀜 없이, 폭도 같게)
        flush();
        // 줄 앞 작은 글자(성경 장절·절 번호)는 따로 작은 글자로
        const w0 = l.words?.[0];
        const smallTxt = w0?.small && l.text.startsWith(w0.text) && l.text.length > w0.text.length ? w0.text : null;
        const smallSize = smallTxt ? Math.max(5, Math.round(size * Math.min(0.85, w0.small / 0.97 * 0.97) * 2) / 2) : size;
        const restTxt = smallTxt ? l.text.slice(smallTxt.length).replace(/^\s*/, ' ') : l.text;
        const chars = [...(smallTxt || '') + restTxt];
        const sum = [...(smallTxt || '')].reduce((a, c) => a + adv(c, font), 0) * smallSize / size + [...restTxt].reduce((a, c) => a + adv(c, font), 0);
        // 오른쪽 끝까지 찬 본문 줄은 모든 쪽에서 같은 판면 폭으로(오른쪽 끝이 한 줄로 맞게)
        const indPt = snapInd(indent) * em / k;
        const widthPt = (!l.role && rightGap < 0.7 && !centered ? (C ? C.wPt : textWfr) - indPt : (l.x1 - l.x0) / k) * 0.99;
        // 자간은 -25%~+15% 안에서만 (사진의 휨·잡티로 폭이 잘못 재어져도 글자가 흩어지지 않게)
        const sp = chars.length > 1 ? Math.max(-25, Math.min(15, Math.floor((widthPt / size - sum) / (chars.length - 1) * 100))) : spacing;
        // 굵은 제목: 본문보다 먹이 확실히 진하고 짧은 줄
        const bold = !pnoOnly && !longLine && p.inkMed > 0 && l.ink > p.inkMed * 1.3 && size >= sizePt * 1.08;
        let lineSize = size;
        let runs = smallTxt ? [run(smallTxt, smallSize, sp), run(restTxt, size, sp)] : [run(l.text, size, sp)];
        // 머리말·꼬리말: 낱말마다 크기가 다르다(큰 쪽 번호 + 작은 책 제목) → 낱말 크기대로 나눠 담는다
        if (l.role && l.words?.length > 1) {
          const sz = (w) => Math.max(5, Math.round((w.y1 - w.y0) / 0.97 / k * 2) / 2);
          const ws = l.words.slice().sort((a, b) => a.x0 - b.x0);
          const base = pct(ws.filter(w => /[가-힣]/.test(w.text)).map(sz), 0.3) || size;   // 다시 읽은 상자는 들쭉날쭉 → 아래쪽 값
          runs = [];
          // 낱말 사이 띄움은 앞서 정리한 줄 글(l.text)을 따른다(글자 조각 상자 사이 틈은 자간 때문에 믿기 어렵다)
          const tc = [...l.text]; let tp = 0;
          const spBefore = ws.map(w => {
            let sp = false; const c0 = [...w.text.trim()][0];
            while (tp < tc.length && tc[tp] !== c0) { if (/\s/.test(tc[tp])) sp = true; tp++; }
            if (tp >= tc.length) return null;
            tp += [...w.text.trim()].length; return sp;
          });
          const aligned = spBefore.every(v => v !== null);
          ws.forEach((w, wi) => {
            const s0 = /^\d{2,}$/.test(w.text) && sz(w) > base * 1.25 ? Math.min(sz(w), base * 2.2) : base;
            const last = runs[runs.length - 1];
            // 낱말(글자 조각) 사이가 좁으면 붙여 쓴다(제목·꼬리말도 한 글자씩 읽힐 수 있다)
            const pw = ws[wi - 1], gapPx = pw ? w.x0 - pw.x1 : 0;
            const sep = !pw ? '' : aligned ? (spBefore[wi] ? ' ' : '') : (gapPx > Math.min(w.y1 - w.y0, pw.y1 - pw.y0) * 0.25 || (/[A-Za-z0-9.,]$/.test(pw.text) && /^[A-Za-z0-9]/.test(w.text) && gapPx > 2)) ? ' ' : '';
            if (last && last.size === s0) last.text += sep + w.text; else runs.push(run(sep + w.text, s0, sp));
          });
          const tot = runs.reduce((a, r) => a + [...r.text].reduce((b, c) => b + adv(c, font), 0) * r.size, 0);
          const nch = runs.reduce((a, r) => a + [...r.text].length, 0);
          const sp2 = nch > 1 ? Math.max(-25, Math.min(15, Math.floor(((l.x1 - l.x0) / k * 0.99 - tot) / (nch - 1) / base * 100))) : 0;
          for (const r of runs) r.spacing = sp2;
          lineSize = Math.max(...runs.map(r => r.size));
        }
        if (bold) for (const r of runs) r.bold = true;
        // 본문 줄의 들여쓰기는 0 또는 한 글자(사진의 휨으로 줄 머리가 들쭉날쭉한 것 맞추기), 틀 왼쪽 기준
        let leftPt = centered ? 0 : C ? Math.max(0, snapInd(indent) * em / k) : Math.max(0, (l.role ? l.x0 / k : p.bx0 / k + snapInd(indent) * em / k) + (p.frameShift || 0) - exLeft);
        // 한 줄이 판 밖으로 넘쳐 다음 줄로 접히지 않게: 들어갈 폭보다 길면 그 줄 글자를 조금 줄인다
        {
          const areaPt = C ? C.cellPt : M.page.w - Math.max(3 * MM, exLeft) - Math.max(3 * MM, Math.min(M.page.w - Math.max(3 * MM, exLeft) - textWfr * 1.06, M.page.w * 0.3)), slack = C ? 0.97 : 0.95;   // 글꼴 너비 어림값 오차만큼 여유
          let wid = runs.reduce((a, r) => a + [...r.text].reduce((b, c) => b + adv(c, font), 0) * r.size + [...r.text].length * (r.spacing ?? 0) / 100 * r.size, 0);
          // 영어·숫자·기호가 많은 줄은 글꼴 너비 어림값이 모자라 한글에서 줄이 접히곤 한다(접히면 한 줄이 늘어 쪽이 넘친다) → 그만큼 넉넉히 잡는다
          { const tx = runs.map(r => r.text).join(''), la = (tx.match(/[!-~]/g) || []).length, sp = (tx.match(/ /g) || []).length; if (tx.length) wid *= 1 + 0.12 * la / tx.length + (la >= tx.length * 0.1 ? 0.12 * sp / tx.length : 0); }
          // 판면 오른쪽 밖에서 시작하는 줄(그림 옆 딱지 글): 글자를 0 아래로 줄이지 말고 줄 머리를 안으로 당긴다
          if (wid > 0 && (areaPt - leftPt) * slack < wid * 0.7) leftPt = Math.max(0, areaPt - wid * 0.7 / slack);
          const availPt = (areaPt - leftPt) * slack;
          var fitNeed = wid > 0 ? Math.max(0.5, Math.min(1, availPt / wid)) : 1;
        }
        runs = colorRuns(runs, l.words);
        if (opts.markFixes) runs = markFixRuns(runs, l.words);
        cur = {
          align: centered ? 'CENTER' : 'LEFT',
          left: leftPt, right: 0, indent: 0,
          before, pct: pagePct, size: lineSize, runs, pageBreak: pageStart, hardBreak: true, wordBreak: false,
          _rules: ruleAt.get(l) || null, _role: l.role || null, _bottom: !!l.role && li >= seq.length - 2 && li > 0, _fit: fitNeed, _body: !l.role && Math.abs(lineSize - sizePt) < 0.6,
        };
        if (li === 0 && floats.length) cur.floats = floats;
        flush();
      } else {
        const startsNew = !cur || big || centered || cur._ended || indent > 0.45 || before > 0.4 * sizePt || cur._big || cur._centered || li === 0;
        if (startsNew) {
          flush();
          cur = { align: centered ? 'CENTER' : 'JUSTIFY', left: 0, right: 0, indent: centered ? 0 : Math.max(0, Math.min(6, Math.round(indent * 2) / 2)) * sizePt, before, pct: linePct, size, runs: [run(l.text, size)], pageBreak: pageStart, hardBreak: true, wordBreak: false, _big: big, _centered: centered };
          if (li === 0 && floats.length) cur.floats = floats;
        } else {
          const last = cur.runs.at(-1), prevText = last.text;
          const endsWord = /[다고며서는은을를의에로만과와도게면니데께듯요]$/.test(prevText);
          last.text = prevText + (/[.,!?:;)」』”’]$/.test(prevText) || !hangulish(prevText.slice(-1)) || !hangulish(l.text[0]) || endsWord ? ' ' : '') + l.text;
        }
        cur._ended = rightGap > 1.2 && !centered;
      }
      prevSize = size; prevBase = l.base;
    });
    };
    layoutLines(seq, null);
    if (exact && loosePics.length) {
      // 글줄이 없는 쪽(그림만 있는 쪽): 빈 문단 하나에 쪽 기준 자리로 붙인다
      flush();
      paras.push({ align: 'LEFT', left: 0, right: 0, indent: 0, before: 0, pct: 100, size: sizePt, runs: [run(' ', sizePt)], pageBreak: pi > 0 && opts.pageBreaks !== false, hardBreak: true, wordBreak: false, floats: loosePics });
    }
    if (!exact) flush();
  });
  flush();
  // 표(두 단 구역) 칸 안의 문단까지 모두
  const everyPara = () => paras.flatMap(q => (q.k === 'tbl' ? [q, ...q.cells.flatMap(c => c.paras)] : [q]));
  for (const p of everyPara()) { delete p._big; delete p._centered; delete p._ended; p.runs = p.runs.flatMap(splitGreek); }
  // 줄 그대로 모드는 사진 한 장마다 쪽을 나누므로, 아래 여백은 넘침 막이로 작게(보이는 자리는 같다)
  const textWall = median(pages.filter(p => p.body.length).map(p => (p.bx1 - p.bx0) / p.pxPerPt));
  const page = exact ? { ...M.page, left: Math.max(3 * MM, exLeft), right: Math.max(3 * MM, Math.min(M.page.w - Math.max(3 * MM, exLeft) - textWall * 1.06, M.page.w * 0.3)), bottom: Math.min(M.page.bottom, 8 * MM) } : M.page;
  if (exact) {
    // 판 폭에 넘치는 줄: 본문 줄은 책 전체에 같은 비율로 줄여 모든 쪽 글자 크기를 같게, 그래도 넘치는 줄만 따로 더
    const needs = everyPara().filter(q => q._body && q._fit < 1).map(q => q._fit);
    const fb = needs.length >= 2 ? Math.min(...needs.sort((a, b) => a - b).slice(0, Math.max(1, Math.ceil(needs.length * 0.9)))) : 1;
    const shrink = (q, f) => { for (const r of q.runs) r.size = Math.floor(r.size * f * 2) / 2; q.size = Math.max(...q.runs.map(r => r.size)); };
    for (const q of everyPara()) {
      if (q._body && fb < 1) shrink(q, fb);
      const rest = (q._fit ?? 1) / (q._body ? fb : 1);
      if (rest < 1) shrink(q, rest);
    }
    // 두 단 표가 판면 폭을 넘지 않게
    for (const q of paras) if (q.k === 'tbl') {
      const avail = page.w - page.left - page.right - q.left - 1, tot = q.cols.reduce((a, b) => a + b, 0);
      if (!(tot > avail && avail > 20)) continue;
      // 칸이 좁아진 만큼 칸 안 글자도 줄인다(그대로 두면 줄마다 다음 줄로 접혀 칸이 길어지고 쪽을 넘긴다)
      const f = avail / tot; q.cols = q.cols.map(v => v * f);
      for (const c of q.cells) { c.mar.left *= f; for (const x of c.paras) { x.left *= f; shrink(x, f); } }
    }
    // 표 칸 안의 줄들이 칸 높이(구역 높이)를 넘으면 줄 사이 → 줄 간격 → 글자 크기 차례로 줄여 맞춘다(넘치면 칸이 길어져 다음 쪽으로 밀린다)
    const fitCells = (q) => {
      for (const c of q.cells) {
        const used = () => c.paras.reduce((a, x) => a + x.before + x.size * x.pct / 100, 0), lim = q.rows[0] * 0.985;
        if (used() <= lim) continue;
        const gaps = c.paras.reduce((a, x) => a + x.before, 0);
        if (used() - gaps < lim) { const f = (lim - (used() - gaps)) / gaps; for (const x of c.paras) x.before *= f; continue; }
        for (const x of c.paras) x.before = 0;
        const f = Math.max(0.6, lim / used());
        for (const x of c.paras) x.pct = Math.max(100, Math.floor(x.pct * f));
        if (used() > lim) { const fs = Math.max(0.7, lim / used()); for (const x of c.paras) shrink(x, fs); }
      }
    };
    for (const q of paras) if (q.k === 'tbl') fitCells(q);
    fitPages(paras, page);
    // 쪽 맞추기가 표(두 단 구역)의 높이를 줄였으면 실제 칸 높이와 칸 안 줄도 그만큼 줄인다(안 그러면 표만 그대로 커서 꼬리말이 다음 쪽으로 넘어간다)
    for (const q of paras) if (q.k === 'tbl') {
      const t = q.size * q.pct / 100;
      if (t < q.rows[0] - 0.5) { q.rows = [t]; fitCells(q); }
      q.size = q.rows[0]; q.pct = 100;
    }
    alignFooters(paras, page);
    // 마지막 확인: 꼬리말 자리를 맞춘 뒤에도 쪽 높이를 넘으면(판면이 쪽 끝까지 찬 사진) 아래쪽 간격부터 줄인다 — 한 줄이라도 넘치면 쪽이 하나 더 생긴다
    {
      const limit = (page.h - page.top - page.bottom) * 0.975, groups = [];
      for (const q of paras) { if (!groups.length || q.pageBreak) groups.push([]); groups.at(-1).push(q); }
      for (const g of groups) {
        let excess = g.reduce((a, q) => a + q.before + q.size * q.pct / 100, 0) - limit;
        for (let i = g.length - 1; i > 0 && excess > 0; i--) { const cut = Math.min(g[i].before, excess); g[i].before -= cut; excess -= cut; }
        if (globalThis.process?.env?.FITDBG) console.error('FIT', g.length, 'used', Math.round(g.reduce((a, q) => a + q.before + q.size * q.pct / 100, 0)), 'limit', Math.round(limit), 'excess', Math.round(excess), g.map(q => (q.k === 'tbl' ? 'T' : '') + Math.round(q.before) + '+' + (q.size * q.pct / 100).toFixed(1) + (q.runs?.some(r => r.size > q.size + 0.01) ? '!' + Math.max(...q.runs.map(r => r.size)).toFixed(1) : '') + (q.floats?.length ? 'F' : '')).join(' '));
      }
    }
    // 줄·상자를 붙일 문단에 '문단 위 간격'이 있으면, 한글은 그 문단 기준 자리를 다르게 잡는다(사진 비교로 확인).
    //  그 간격을 같은 높이의 빈 문단으로 바꿔 두고, 글줄 위로 올라가는 줄(제목 위 선)은 그 빈 문단에 붙인다
    for (let i = 0; i < paras.length; i++) {
      const q = paras[i];
      if (!q._rules || !(q.before > 1)) continue;
      const h = Math.round(q.before * 2) / 2;
      const sp = { align: 'LEFT', left: 0, right: 0, indent: 0, before: 0, pct: 100, size: h, runs: [{ ...(q.runs[0] || run(' ', h)), text: ' ', size: h }], pageBreak: q.pageBreak, hardBreak: true, wordBreak: false, floats: q.floats };
      delete q.floats; q.pageBreak = false; q.before = 0;
      const up = q._rules.filter(r => r.dy < 0); q._rules = q._rules.filter(r => r.dy >= 0);
      if (up.length) sp._rules = up.map(r => ({ ...r, dy: Math.max(0, h + r.dy) }));
      paras.splice(i, 0, sp); i++;
    }
    // 붙여 둔 가로 줄: 글줄의 실제 자리(위 여백 + 앞 문단들 높이) 기준으로 그린다
    let first = null, y = 0;
    for (const q of paras) {
      if (!first || q.pageBreak) { first = q; y = 0; }
      y += q.before;
      if (q._rules) {
        // 그 글줄(문단)에 붙여 두고, 문단 위에서 잰 거리로 놓는다(한글이 문단 자리를 정하므로 글과 함께 움직인다)
        q.floats = q.floats || [];
        for (const r of q._rules) {
          if (r.dy < 0) r.dy = 0;   // 한글은 문단 위쪽(음수) 자리를 받지 않는다
          if (r.type === 'pic') q.floats.push({ type: 'pic', vrel: 'PARA', x0: r.x0, y0: r.dy, w: r.w, h: r.h, data: r.data, ext: r.ext, mime: r.mime, pxW: r.pxW, pxH: r.pxH, behind: !!r.behind });
          else if (r.type === 'rect') q.floats.push({ type: 'rect', vrel: 'PARA', x0: r.x0, y0: r.dy, w: r.w, h: Math.min(r.h, page.h - (page.top + y + r.dy) - 2), fill: r.fill, ratio: r.ratio, behind: true });
          else q.floats.push({ type: 'line', vrel: 'PARA', x1: r.x1, x2: r.x2, y1: r.dy, y2: r.dy, w: r.w, color: '000000' });
        }
      }
      y += q.size * q.pct / 100;
    }
  }
  for (const p of everyPara()) { delete p._rules; delete p._role; delete p._bottom; delete p._fit; delete p._body; }
  return { paras, page, notes };
}

// 원어(헬라어·히브리어) 부분은 그 글자가 다 있는 글꼴로 (한글 글꼴엔 ἐ·ῇ나 히브리어 모음 부호 붙은 글자가 없다)
export const GREEK_FONT = 'Times New Roman';
const ORIG = '\\u0370-\\u03FF\\u1F00-\\u1FFF\\u0590-\\u05FF\\uFB1D-\\uFB4F';
const ORIG_RE = new RegExp(`([${ORIG}](?:[${ORIG}\\u0300-\\u036F.,;:·'’᾽ ]*[${ORIG}.,;:·'’᾽])?)`);
function splitGreek(r) {
  if (!new RegExp(`[${ORIG}]`).test(r.text)) return [r];
  return r.text.split(ORIG_RE).filter(Boolean).map(t => new RegExp(`[${ORIG}]`).test(t) ? { ...r, text: t, font: GREEK_FONT } : { ...r, text: t });
}

// 꼬리말·쪽 번호는 모든 쪽에서 같은 높이에: 쪽마다 본문 길이가 달라도, 가장 아래 놓이는 쪽의 자리에 맞춰 나머지를 내린다
function alignFooters(paras, page) {
  const avail = (page.h - page.top - page.bottom) * 0.96;
  const groups = [];
  for (const p of paras) { if (!groups.length || p.pageBreak) groups.push([]); groups.at(-1).push(p); }
  const lineH = q => q.size * q.pct / 100;
  const info = groups.map(g => {
    const fi = g.findIndex(q => q._bottom);
    if (fi < 0) return null;
    const yPrev = g.slice(0, fi).reduce((a, q) => a + q.before + lineH(q), 0);
    return { g, fi, yPrev, natural: yPrev + g[fi].before };
  }).filter(Boolean);
  if (info.length < 2) return;
  const fh = Math.max(...info.map(x => x.g.slice(x.fi).reduce((a, q) => a + lineH(q), 0)));
  const target = Math.min(Math.max(...info.map(x => x.natural)), avail - fh);
  for (const x of info) {
    const extra = x.g.slice(x.fi + 1).reduce((a, q) => a + q.before, 0);   // 꼬리말이 두 줄이면 둘째 줄 간격은 그대로
    if (target >= x.yPrev) x.g[x.fi].before = target - x.yPrev;
    void extra;
  }
}

// 사진 한 장 = 한 쪽: 쪽마다 줄들이 판면 높이 안에 들어가도록 줄 사이 여백 → 줄 간격 → 글자 크기 순으로 줄인다
// (휜 사진·판형 추정 오차로 세로가 조금 길게 재어지면 다음 쪽으로 넘쳐 쪽 수가 늘어나는 것을 막는다)
function fitPages(paras, page) {
  const avail = (page.h - page.top - page.bottom) * 0.96;
  const groups = [];
  for (const p of paras) { if (!groups.length || p.pageBreak) groups.push([]); groups.at(-1).push(p); }
  for (const g of groups) {
    const lineH = q => q.size * q.pct / 100;
    const used = () => g.reduce((a, q) => a + q.before + lineH(q), 0);
    let u = used();
    if (u <= avail) continue;
    const gaps = g.reduce((a, q) => a + q.before, 0), lines = u - gaps;
    if (lines < avail) { const f = (avail - lines) / gaps; for (const q of g) q.before *= f; continue; }
    for (const q of g) q.before *= 0.3;
    u = used();
    const fp = Math.max(0.6, avail / u);
    for (const q of g) {
      const pct = Math.max(100, Math.floor(q.pct * fp));
      q.pct = pct;
    }
    u = used();
    if (u > avail) {
      const fs = Math.max(0.7, avail / u);
      for (const q of g) { q.size = Math.round(q.size * fs * 2) / 2; for (const r of q.runs) r.size = q.size; }
    }
  }
}

// ── 읽은 결과 다듬기 (사진 한 쪽마다) ──
// 1) 낱말을 바닥선에 맞춰 줄에 다시 넣기: 휜 종이는 한 줄의 끝이 아래·위 줄로 섞여 읽힌다
// 2) 작은 글자(성경 장절 표시·절 번호)는 크게 키워 다시 읽기
// 3) 줄마다 먹 진하기(굵은 제목 찾기)
function upscale(g, W, H, x0, y0, x1, y1, f) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
  const w = x1 - x0, h = y1 - y0, ow = w * f, oh = h * f, o = new Uint8Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(h - 1.001, Math.max(0, (y + 0.5) / f - 0.5)), iy = Math.floor(sy), fy = sy - iy;
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(w - 1.001, Math.max(0, (x + 0.5) / f - 0.5)), ix = Math.floor(sx), fx = sx - ix;
      const i = (y0 + iy) * W + x0 + ix;
      const v = g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) + g[i + W] * (1 - fx) * fy + g[i + W + 1] * fx * fy;
      o[y * ow + x] = v;
    }
  }
  return { g: o, w: ow, h: oh };
}
const lineOf = (ws) => ({ words: ws, text: ws.map(w => w.text).join(' '), x0: Math.min(...ws.map(w => w.x0)), y0: Math.min(...ws.map(w => w.y0)), x1: Math.max(...ws.map(w => w.x1)), y1: Math.max(...ws.map(w => w.y1)) });

// 성경 장절: '창세기 32126' → '창세기 32:26' (쌍점을 1로 잘못 읽은 것; 성경 책 이름일 때만)
const BIBLE_BOOKS = '창세기 출애굽기 레위기 민수기 신명기 여호수아 사사기 룻기 사무엘상 사무엘하 열왕기상 열왕기하 역대상 역대하 에스라 느헤미야 에스더 욥기 시편 잠언 전도서 아가 이사야 예레미야 예레미야애가 에스겔 다니엘 호세아 요엘 아모스 오바댜 요나 미가 나훔 하박국 스바냐 학개 스가랴 말라기 마태복음 마가복음 누가복음 요한복음 사도행전 로마서 고린도전서 고린도후서 갈라디아서 에베소서 빌립보서 골로새서 데살로니가전서 데살로니가후서 디모데전서 디모데후서 디도서 빌레몬서 히브리서 야고보서 베드로전서 베드로후서 요한일서 요한이서 요한삼서 유다서 요한계시록 창 출 레 민 신 수 삿 룻 삼상 삼하 왕상 왕하 대상 대하 스 느 에 욥 시 잠 전 아 사 렘 애 겔 단 호 욜 암 옵 욘 미 나 합 습 학 슥 말 마 막 눅 요 행 롬 고전 고후 갈 엡 빌 골 살전 살후 딤전 딤후 딛 몬 히 약 벧전 벧후 요일 요이 요삼 유 계'.split(' ');
export function fixVerseRef(t) {
  const m = t.match(/^([가-힣]{1,8})\s*(\d{3,6})$/);
  if (!m || !BIBLE_BOOKS.includes(m[1])) return t;
  const d = m[2];
  for (let i = 1; i < d.length - 1; i++) {
    if (d[i] !== '1') continue;
    const c = +d.slice(0, i), v = d.slice(i + 1);
    if (c >= 1 && c <= 150 && +v >= 1 && +v <= 176 && v[0] !== '0') return `${m[1]} ${c}:${v}`;
  }
  return t;
}

export async function refineOcr(lines, part, ocr, ocrLatin = null) {
  const { g, w: W, h: H } = part;
  let L = lines.map(l => ({ ...l, words: (l.words || []).filter(w => w.text?.trim()).map(w => ({ ...w })) })).filter(l => l.words.length);
  const hs = L.flatMap(l => l.words.filter(w => /[가-힣]/.test(w.text)).map(w => w.y1 - w.y0));
  const hMed = median(hs) || 20;
  // 줄 안의 키가 터무니없이 큰 조각(책 모서리·그림자 줄을 글로 읽은 것)은 뗀다 → 줄 상자가 부풀지 않게
  L = L.map(l => {
    const mh = median(l.words.map(w => w.y1 - w.y0));
    const ws = l.words.filter(w => !((w.y1 - w.y0) > Math.max(mh, hMed) * 2.2 && !/[가-힣A-Za-z0-9\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(w.text)));   // 원어·숫자는 둔다(모음 부호 붙은 히브리어는 키가 크다)
    return ws.length === l.words.length ? l : (ws.length ? lineOf(ws) : null);
  }).filter(Boolean);
  // 1) 휜 종이: 한 줄의 끝 낱말들이 아래 줄 끝에 붙어 읽히는 일이 있다(물결 모양으로 휘면 직선 맞춤도 안 맞는다).
  //    자기 줄 앞 낱말과는 멀리 떨어져 있고, 다른 줄의 낱말 바로 뒤(같은 높이)에 이어지면 그 줄로 옮긴다
  const vov = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.4 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
  for (let pass = 0; pass < 2; pass++) {
    L.forEach((l, li) => {
      l.words.sort((a, b) => a.x0 - b.x0);
      for (let i = 1; i < l.words.length; i++) {
        const w = l.words[i], prev = l.words[i - 1];
        if (w.x0 - prev.x1 < hMed * 3) continue;
        let best = null, bg = Infinity;
        L.forEach((m, mi) => {
          if (mi === li) return;
          // 그 줄의 맨 끝 낱말 바로 뒤에 이어질 때만 (다른 단의 글을 끌어오지 않게)
          const u = m.words.reduce((a, v) => (v.x1 > a.x1 ? v : a), m.words[0]);
          const gap = w.x0 - u.x1;
          if (gap > -hMed * 0.3 && gap < hMed * 1.5 && vov(u, w) && gap < bg) { bg = gap; best = m; }
        });
        const tail = l.words.slice(i);
        if (best && tail.length <= 4 && tail.every(t => vov(t, w))) { l.words.splice(i); best.words.push(...tail); break; }
      }
    });
  }
  L = L.filter(l => l.words.length).map(l => lineOf(l.words.sort((a, b) => a.x0 - b.x0)));
  // 1-1) 빠뜨린 줄 찾기: 글자 인식이 통째로 건너뛴 줄(뒷면 비침 등으로)이 있으면 그 자리만 잘라 다시 읽는다.
  //      이웃한 두 줄 사이가 줄 하나 들어갈 만큼 비어 있고, 그 사이에 먹이 있으면 빠뜨린 줄
  {
    L.sort((a, b) => a.y0 - b.y0);
    const longL = L.filter(l => l.x1 - l.x0 > W * 0.25);
    const colX0 = longL.length ? median(longL.map(l => l.x0)) : W * 0.1, colX1 = longL.length ? median(longL.map(l => l.x1)) : W * 0.9;
    // 제대로 읽힌 줄만 기준으로 (잡티 줄이 사이를 막지 않게)
    const R = L.filter(l => l.words.filter(w => /[가-힣]/.test(w.text) && (w.conf ?? 80) >= 60).length >= 2);
    const gaps = []; for (let i = 1; i < R.length; i++) gaps.push(R[i].y0 - R[i - 1].y0);
    const pitch = median(gaps.filter(v => v > hMed)) || hMed * 1.8;
    let budgetMiss = 8;
    const found = [];
    for (let i = 1; i < R.length && budgetMiss > 0; i++) {
      const a = R[i - 1], b = R[i];
      if (b.y0 - a.y1 < hMed * 1.1 || b.y0 - a.y0 > pitch * 4) continue;
      const y0 = a.y1 + hMed * 0.15, y1 = b.y0 - hMed * 0.15;
      const x0 = Math.max(0, colX0 - hMed), x1 = Math.min(W, colX1 + hMed);
      // 사이에 글자 먹이 있는지 (가운데 띠에서 어두운 점 비율)
      let n = 0, tot = 0;
      for (let y = Math.round(y0); y < y1; y += 2) for (let x = Math.round(x0 + hMed); x < x1 - hMed; x += 3) { tot++; if (g[y * W + x] < 110) n++; }
      if (!tot || n / tot < 0.01) continue;
      const f = 2, X0 = x0, Y0 = Math.max(0, y0 - hMed * 0.2);
      const up = upscale(g, W, H, X0, Y0, x1, Math.min(H, y1 + hMed * 0.2), f);
      budgetMiss--;
      try {
        const r = await ocr(grayPng(up.g, up.w, up.h), up.w, up.h);
        for (const rl of r || []) {
          const ws = (rl.words || []).filter(w => w.text?.trim() && (w.conf ?? 80) >= 40)
            .map(w => ({ ...w, x0: X0 + w.x0 / f, x1: X0 + w.x1 / f, y0: Y0 + w.y0 / f, y1: Y0 + w.y1 / f }));
          if (ws.length && /[가-힣]{2}/.test(ws.map(w => w.text).join('')) && ws.some(w => w.y1 - w.y0 > hMed * 0.6)) found.push(lineOf(ws.sort((p, q) => p.x0 - q.x0)));
        }
      } catch {}
    }
    if (found.length) {
      // 새로 찾은 줄 자리에 있던 잡티 줄은 버린다. 다만 그 자리 줄이 원어·영어 줄(행간 번역 칸)이거나
      // 새 줄보다 한글이 많으면 그 줄이 진짜 → 새로 읽은 줄을 버린다
      const isLang = (t) => /[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]|[A-Za-z]{3}/.test(t);
      const syl = (t) => (t.match(/[가-힣]/g) || []).length;
      for (const f of found) {
        const O = L.filter(l => !R.includes(l) && Math.min(f.y1, l.y1) - Math.max(f.y0, l.y0) > (l.y1 - l.y0) * 0.5);
        if (isLang(f.text) || O.some(o => isLang(o.text) || syl(o.text) >= syl(f.text))) continue;
        L = L.filter(l => !O.includes(l));
        L.push(f);
      }
      L.sort((a, b) => a.y0 - b.y0);
    }
  }
  // 2) 작은 글자 다시 읽기: 줄 맨 앞(또는 단독 줄)의 키 작은 낱말 묶음
  let budget = 24;
  const longsR = L.filter(l => l.text.replace(/\s/g, '').length >= 15);
  const colL = longsR.length ? median(longsR.map(l => l.x0)) : -Infinity;   // 판면 왼쪽 끝(대강)
  for (const l of L) {
    if (budget <= 0) break;
    // 맨 앞의 동떨어진 한두 글자 잡티(제본·손가락)는 건너뛰고 본다 — 잡티는 뒤에서 떼어 낸다
    const skip = l.words.length > 2 && l.words[1].x0 - l.words[0].x1 > hMed && l.words[0].text.trim().length <= 2 && l.words[0].x1 < colL - hMed ? 1 : 0;
    const lead = l.words.slice(0, skip), ws = l.words.slice(skip);
    const small = [];
    for (const w of ws) {
      if (/[A-Za-z\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(w.text)) break;   // 영어·원어는 다시 읽지 않는다
      const hh = w.y1 - w.y0, junky = !/^[가-힣]+[.,]?$/.test(w.text) || (w.conf ?? 100) < 70;
      const inside = small.length && (w.x0 + w.x1) / 2 < Math.max(...small.map(v => v.x1));
      const garbled = /\d/.test(w.text) && /[@%#&*!^$]/.test(w.text);   // 작은 장절 표시를 기호 섞어 잘못 읽은 꼴(%주4091!)
      const near = !small.length || w.x0 - small[small.length - 1].x1 < hMed * 0.5;   // 작은 글자 묶음에 바로 붙어 있어야(본문 첫 글자를 끌어들이지 않게)
      if (small.length < 5 && (hh < hMed * 0.78 || (junky && hh < hMed * 0.9 && (near && hh < hMed * 0.8 || !small.length)) || (garbled && hh < hMed * 1.3) || inside)) small.push(w); else break;
    }
    if (small.length && !small.some(w => w.y1 - w.y0 < hMed * 0.9 || (/\d/.test(w.text) && /[@%#&*!^$]/.test(w.text)))) continue;
    if (!small.length) continue;
    const rest = ws.slice(small.length);
    // 줄 전체가 작은 글(꼬리말·쪽 번호 등)은 그대로 — 장절 한 줄(시편 6:6~9)처럼 짧은 것만 다시 읽는다
    if (ws.length > 3 && ws.filter(w => w.y1 - w.y0 < hMed * 0.85).length >= ws.length * 0.7) continue;
    if (rest.length && rest[0].x0 - small.at(-1).x1 < hMed * 0.15) continue;   // 작은 글자가 바로 붙은 본문 글자의 일부인 경우
    const bx = { x0: Math.min(...small.map(w => w.x0)), y0: Math.min(...small.map(w => w.y0)), x1: Math.max(...small.map(w => w.x1)), y1: Math.max(...small.map(w => w.y1)) };
    const sh = bx.y1 - bx.y0, pad = sh * 0.5;
    // 오른쪽으로 조금 넉넉히(번호가 덜 잡히지 않게) — 뒤에 붙은 본문 글자는 아래에서 장절 모양만 떼어 쓴다
    const up = upscale(g, W, H, bx.x0 - pad, bx.y0 - pad, bx.x1 + pad + (rest.length ? Math.min(hMed * 2, Math.max(0, rest[0].x0 - bx.x1 - pad - 2)) : 0), bx.y1 + pad, sh < hMed * 0.55 ? 4 : 3);
    budget--;
    let r;
    try { r = await ocr(grayPng(up.g, up.w, up.h), up.w, up.h); } catch { continue; }
    // 장절 표시 다듬기: 한 글자씩 띄워 읽힌 책 이름 붙이기, 4-10 → 4:10, 떠도는 괄호 빼기
    let t = cleanText((r || []).map(x => x.text).join(' ')).replace(/\s*:\s*/g, ':');
    t = t.replace(/(?<=[가-힣])\s+(?=[가-힣])/g, '').replace(/(\d)\s*[-–.;]\s*(\d)/, '$1:$2').replace(/\(\s*(?=\d)/, '').replace(/\s*\)\s*(?=\d)/, ') ').replace(/\s+/g, ' ').trim();
    const lab = t.match(/^\(?\s*[가-힣]{1,8}\s*\)?\s*(?:\d{1,3}:\d{1,3}(?:[~\-–]\d{1,3})?|\d{1,6})/);
    if (lab) t = lab[0].replace(/\(\s*/, '(').replace(/\s*\)\s*/, ') ').replace(/^([가-힣]{2,8})\s*(\d)/, '$1 $2').trim();
    t = fixVerseRef(t);
    const conf = (r || []).flatMap(x => x.words || []).map(w => w.conf ?? 80);
    const mc = conf.length ? conf.reduce((a, b) => a + b) / conf.length : 0;
    // 성경 장절(창세기 32:26 · 시편 6:6~9 · (표준새번역) 10) 또는 절 번호(6) 모양일 때만 받아들인다
    // 절 번호(작은 숫자 하나): 뒤에 붙은 본문 글자는 버리고 숫자만
    if (small.length === 1 && small[0].text.trim().length <= 2 && /^\d{1,3}(\s|$)/.test(t)) t = t.match(/^\d{1,3}/)[0];
    // 뒤 낱말이 이미 숫자(장절)면 이름만 (같은 숫자를 두 번 넣지 않게)
    if (rest.length && /^\(?\d/.test(rest[0].text) && /[가-힣]/.test(t)) t = t.replace(/\s*\d.*$/, '').trim();
    const ok = /^\(?[가-힣]{1,8}\)?\s*\d{1,3}(:\d{1,3}([~\-–]\d{1,3})?)?$/.test(t) || (small.length === 1 && /^\d{1,3}$/.test(t)) || (mc >= 75 && /[가-힣]{2}/.test(t) && t.length <= 14);
    if (!ok) continue;
    const nw = { text: t, x0: bx.x0, y0: bx.y0, x1: bx.x1, y1: bx.y1, conf: Math.max(mc, 80), small: sh / hMed };
    Object.assign(l, lineOf([...lead, nw, ...rest]));
  }
  // 2-1b) 본문 아래·위 여백에 홀로 떨어진 쪽 번호·꼬리말: 통째 읽기에서 빠지기 쉽다(본문과 멀리 떨어진 작은 글씨)
  {
    const body = L.filter(l => /[가-힣]{2}/.test(l.text) && l.x1 - l.x0 > W * 0.3);
    if (globalThis.__koDbg) console.error('MB', body.length, budget, W, H, Math.round(hMed));
    if (body.length >= 5) {
      const bx0 = pct(body.map(l => l.x0), 0.1), bx1 = pct(body.map(l => l.x1), 0.9);
      const xa = Math.max(0, Math.round(bx0 - hMed * 1.5)), xb = Math.min(W - 1, Math.round(bx1 + hMed * 1.5));
      const lastY = Math.max(...body.map(l => l.y1)), firstY = Math.min(...body.map(l => l.y0));
      const bands = [[Math.round(lastY + hMed * 0.8), Math.round(Math.min(H - 2, lastY + hMed * 6))], [Math.round(Math.max(1, firstY - hMed * 6)), Math.round(firstY - hMed * 0.8)]];
      for (const [ya, yb] of bands) {
        if (globalThis.__koDbg) console.error('BAND', ya, yb, L.filter(l => l.y1 > ya && l.y0 < yb).map(l => [l.text, Math.round(l.x0), Math.round(l.x1), Math.round(l.y0)]));
        if (yb - ya < hMed || budget <= 0) continue;
        if (L.some(l => l.y1 > ya && l.y0 < yb && l.x1 > xa && l.x0 < xb && (l.text.match(/[0-9가-힣]/g) || []).length >= 2)) continue;   // 이미 읽힌 줄이 있으면
        const vals = []; for (let y = ya; y < yb; y += 3) for (let x = xa; x < xb; x += 3) vals.push(g[y * W + x]);
        const t = Math.max(90, Math.min(140, otsu(vals)));
        // 먹이 있는 줄(가로 띠) 찾기
        const rows = [];
        for (let y = ya; y < yb; y++) { let c = 0; for (let x = xa; x < xb; x++) if (g[y * W + x] < t) c++; rows.push(c); }
        // 먹 띠 덩어리들 중 글줄 높이에 맞고 먹이 가장 많은 것
        const segs = []; let cur = null;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i] > 2) { if (cur && i - cur.b <= hMed * 0.3) { cur.b = i; cur.ink += rows[i]; } else { cur = { a: i, b: i, ink: rows[i] }; segs.push(cur); } }
        }
        const seg = segs.filter(q => q.b - q.a <= hMed * 2.2 && q.b - q.a >= hMed * 0.25).sort((p, q) => q.ink - p.ink)[0];
        if (globalThis.__koDbg) console.error('ROWS', ya, yb, xa, xb, t, Math.min(...vals), Math.max(...rows));
        if (globalThis.__koDbg) console.error('SEGS', segs.map(q => [q.a + ya, q.b - q.a, q.ink]));
        if (!seg) continue;
        const y0 = seg.a, y1 = seg.b;
        const Y0 = ya + y0, Y1 = ya + y1;
        let X0 = xb, X1 = xa;
        for (let y = Y0; y <= Y1; y++) for (let x = xa; x < xb; x++) if (g[y * W + x] < t) { if (x < X0) X0 = x; if (x > X1) X1 = x; }
        const pad = hMed * 0.6, f2 = 2;
        const up = upscale(g, W, H, Math.max(0, X0 - pad), Math.max(0, Y0 - pad), Math.min(W - 1, X1 + pad), Math.min(H - 1, Y1 + pad), f2);
        budget--;
        let r; try { r = await ocr(grayPng(up.g, up.w, up.h), up.w, up.h); } catch { continue; }
        const ws = (r || []).flatMap(x => x.words || []).filter(v => v.text?.trim() && (v.conf ?? 0) >= 55 && /[0-9가-힣A-Za-z]/.test(v.text))
          .map(v => ({ ...v, x0: Math.max(0, X0 - pad) + v.x0 / f2, x1: Math.max(0, X0 - pad) + v.x1 / f2, y0: Math.max(0, Y0 - pad) + v.y0 / f2, y1: Math.max(0, Y0 - pad) + v.y1 / f2 }));
        if (globalThis.__koDbg) console.error('MARGIN', ya, yb, ws.map(v => v.text + ':' + Math.round(v.conf)));
        if (ws.length) { L.push(lineOf(ws)); L.sort((p, q) => p.y0 - q.y0); }
      }
    }
  }
  // 2-2) 쪽 위아래 끝의 짧은 줄(머리말·꼬리말·쪽 번호)은 작은 글씨가 많아 통째로 키워 다시 읽는다
  for (const l of L) {
    if (budget <= 0) break;
    const nearEdge = l.y0 > H * 0.86 || l.y1 < H * 0.1;
    if (!nearEdge || l.text.replace(/\s/g, '').length > 30 || !(/[\d|ㅣ]/.test(l.text) || (l.y0 > H * 0.88 && l.words.length <= 4)) || /[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]|[A-Za-z]{3}/.test(l.text)) continue;   // 쪽 번호가 든 줄(꼬리말·머리말)만 — 원어·영어 줄은 두 번 읽으면 오히려 망가진다
    const pad = hMed * 0.5;
    const f = 3, X0 = Math.max(0, l.x0 - pad), Y0 = Math.max(0, l.y0 - pad);
    const up = upscale(g, W, H, X0, Y0, l.x1 + pad, l.y1 + pad, f);
    budget--;
    let r;
    try { r = await ocr(grayPng(up.g, up.w, up.h), up.w, up.h); } catch { continue; }
    const mc = (a) => a.reduce((s, w) => s + (w.conf ?? 70), 0) / a.length;
    let ws = (r || []).flatMap(x => x.words || []).filter(w => w.text?.trim());
    // 흑백으로 갈라 한 번 더(작고 흐린 꼬리말 글씨는 이쪽이 잘 읽힐 때가 많다) — 더 또렷이 읽힌 쪽
    if (budget > 0) {
      const bin = new Uint8Array(up.g); const t = otsu(Array.from(bin)); for (let i = 0; i < bin.length; i++) bin[i] = bin[i] < t ? 0 : 255;
      budget--;
      try {
        const r2 = await ocr(grayPng(bin, up.w, up.h), up.w, up.h);
        const ws2 = (r2 || []).flatMap(x => x.words || []).filter(w => w.text?.trim());
        if (ws2.length && (!ws.length || mc(ws2) > mc(ws) + 3)) ws = ws2;
      } catch {}
    }
    if (!ws.length) continue;
    const nn = ws.map(w => ({ ...w, x0: X0 + w.x0 / f, x1: X0 + w.x1 / f, y0: Y0 + w.y0 / f, y1: Y0 + w.y1 / f }));
    const oldN = l.text.replace(/\s/g, '').length, newN = nn.map(w => w.text).join('').length;
    const syl = (t) => (t.match(/[가-힣]/g) || []).length;
    if (mc(nn) >= mc(l.words) + 5 && newN >= oldN * 0.6 && syl(nn.map(w => w.text).join('')) >= syl(l.text) * 0.8) Object.assign(l, lineOf(nn.sort((a, b) => a.x0 - b.x0)));
    // 그래도 쪽 번호가 안 보이면(손가락·그림자가 같은 줄에 걸려 통째로 망가진 경우) 낱말마다 따로 키워 읽는다.
    //  쪽 번호(숫자 1~4자리)가 나오면 그것과 제대로 읽힌 한글 낱말만 남긴다
    if (l.words.some(w => /^\d{1,4}$/.test(w.text.trim()) && (w.conf ?? 80) >= 60) || mc(l.words) >= 60 || l.words.length > 6) continue;
    let num = null;
    for (const w of l.words) {
      if (budget <= 0) break;
      const h = w.y1 - w.y0, p2 = Math.max(h * 0.4, hMed * 0.3), f2 = 3;
      const X2 = Math.max(0, w.x0 - p2), Y2 = Math.max(0, w.y0 - p2);
      const u2 = upscale(g, W, H, X2, Y2, w.x1 + p2, w.y1 + p2, f2);
      { const t = otsu(u2.g); for (let i = 0; i < u2.g.length; i++) u2.g[i] = u2.g[i] < t ? 0 : 255; }   // 흐린 굵은 숫자는 흑백으로 갈라야 잘 읽힌다
      budget--;
      let r2; try { r2 = await ocr(grayPng(u2.g, u2.w, u2.h), u2.w, u2.h); } catch { continue; }
      const w2 = (r2 || []).flatMap(x => x.words || []).filter(v => v.text?.trim());
      const t2 = w2.map(v => v.text).join('').replace(/[^\d]/g, '') === w2.map(v => v.text).join('').trim() ? w2.map(v => v.text).join('') : '';
      const c2 = w2.length ? mc(w2) : 0;
      if (/^\d{1,4}$/.test(t2) && c2 >= 60 && (!num || c2 > num.conf)) num = { ...w, text: t2, conf: c2 };
    }
    if (num) {
      const keep = l.words.filter(w => w !== l.words.find(v => v.x0 === num.x0 && v.y0 === num.y0) && syl(w.text) >= 2 && (w.conf ?? 80) >= 60);
      Object.assign(l, lineOf([...keep, num].sort((a, b) => a.x0 - b.x0)));
    }
  }
  // 2-4) 한글 줄 속 영어 낱말: 한국어 모형은 로마자를 숫자·부호로 읽기 쉽다(Leanne Payne → 90000000*, F 구역 → 『 구역)
  //      한글이 아닌 낱말(또는 한글 사이에 낀 부분)을 영어로 다시 읽어, 영어 글자로 또렷이 읽힐 때만 바꾼다. 숫자는 영어로 읽어도 숫자라 그대로 남는다
  if (ocrLatin) {
    let lb = 30;
    for (const l of L) {
      if (lb <= 0) break;
      if (!/[가-힣]{2}/.test(l.text) || /[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(l.text)) continue;
      for (let wi = 0; wi < l.words.length && lb > 0; wi++) {
        const w = l.words[wi], t = w.text;
        const m = t.match(/^([가-힣]*)([^가-힣]+?)([가-힣]*[.,!?)'"”’]*)$/);
        if (!m || !m[2].trim() || /^[A-Za-z]{3,}[.,;:]?$/.test(m[2]) && (w.conf ?? 0) >= 80) continue;
        const X = m[2];
        if (/^[.,!?;:'"“”‘’()\[\]·…\-–—~]+$/.test(X)) continue;   // 문장 부호만
        if (/^\d{1,4}[.,)]?$/.test(X) && (w.conf ?? 0) >= 80 && !m[1] && !m[3]) continue;   // 또렷한 숫자
        const n = [...t].length, hw = (w.y1 - w.y0) * 0.95;   // 한글 한 자 너비 ≈ 글자 높이
        const xa = w.x0 + [...m[1]].length * hw, xb = w.x1 - [...m[3]].length * hw;
        if (xb - xa < hw * 0.4) continue;
        const pad = hMed * 0.25, f2 = 3;
        const u2 = upscale(g, W, H, Math.max(0, xa - pad), Math.max(0, w.y0 - pad), Math.min(W - 1, xb + pad), Math.min(H - 1, w.y1 + pad), f2);
        lb--;
        let r2; try { r2 = await ocrLatin(grayPng(u2.g, u2.w, u2.h), u2.w, u2.h); } catch { continue; }
        let w2 = (r2 || []).flat().flatMap(x => x.words || [x]).filter(v => v.text?.trim());
        // 덧붙어 읽힌 옆 글자 조각(o|, - 등)은 떼어 낸다: 앞에서부터 영어 낱말인 것만
        { const k = w2.findIndex(v => !/^[("'“‘]?[A-Za-z][A-Za-z'’.\-]*[A-Za-z.]?[)"'”’,.;:]?$/.test(v.text) || (v.text.replace(/[^A-Za-z]/g, '').length === 1 && w2.length > 1 && !/^[A-Z]/.test(v.text))); if (k >= 0) w2 = w2.slice(0, k); }
        w2 = w2.map(v => ({ ...v, text: v.text.replace(/[-–]+$/, '') }));
        const t2 = w2.map(v => v.text).join(' ').trim(), c2 = w2.length ? w2.reduce((a, v) => a + (v.conf ?? 0), 0) / w2.length : 0;
        const letters = (t2.match(/[A-Za-z]/g) || []).length;
        if (globalThis.__koDbg) console.error('TRY', t, '->', t2, Math.round(c2));
        const oddOrig = !/[0-9A-Za-z]/.test(X);   // 원래 부호로 읽힌 자리(『)면 한 글자 대문자는 조금 낮은 확신도 받는다
        if (!t2 || letters < Math.max(1, t2.replace(/\s/g, '').length * 0.7) || c2 < (oddOrig && /^[A-Z]$/.test(t2) ? 60 : 72)) continue;
        if (globalThis.__koDbg) console.error('LAT', t, '->', t2, Math.round(c2), Math.round(w.conf ?? -1));
        const nt = m[1] + t2 + m[3];
        l.words[wi] = { ...w, text: nt, latin: true };
      }
      Object.assign(l, lineOf(l.words));
    }
  }
  // 2-3) 줄 맨 앞에 마침표·쉼표 같은 부호만 읽힌 조각(줄 첫 글자 '이'가 '。,'로 읽히는 식)은 따로 키워 다시 읽는다
  for (const l of L) {
    if (budget <= 0) break;
    const w = l.words[0], nx = l.words[1];
    if (!w || !nx || !/^[。.,·、:;'`]{1,3}$/.test(w.text.trim()) || !/^[가-힣]/.test(nx.text) || nx.x0 - w.x1 > hMed * 0.6) continue;
    const p2 = hMed * 0.3, f2 = 3, X2 = Math.max(0, w.x0 - p2), Y2 = Math.max(0, Math.min(w.y0, nx.y0) - p2);
    const u2 = upscale(g, W, H, X2, Y2, w.x1 + p2 * 0.5, Math.max(w.y1, nx.y1) + p2, f2);
    { const t = otsu(u2.g); for (let i = 0; i < u2.g.length; i++) u2.g[i] = u2.g[i] < t ? 0 : 255; }
    budget--;
    let r2; try { r2 = await ocr(grayPng(u2.g, u2.w, u2.h), u2.w, u2.h); } catch { continue; }
    const w2 = (r2 || []).flatMap(x => x.words || []).filter(v => v.text?.trim());
    const t2 = w2.map(v => v.text).join('').trim(), c2 = w2.length ? w2.reduce((a, v) => a + (v.conf ?? 70), 0) / w2.length : 0;
    if (/^[가-힣]{1,2}$/.test(t2) && c2 >= 75) Object.assign(l, lineOf([{ ...w, text: t2, conf: c2, y0: Math.min(w.y0, nx.y0), y1: Math.max(w.y1, nx.y1) }, ...l.words.slice(1)]));
  }
  // 2-1) 절 번호 차례 맞추기: '시편 6:6~9' 다음에 작은 번호로 시작하는 줄이 꼭 그 개수만큼 있으면 6,7,8,9로
  for (let i = 0; i < L.length; i++) {
    const m = L[i].text.match(/(\d{1,3}):(\d{1,3})\s*[~\-–]\s*(\d{1,3})\s*$/);
    if (!m) continue;
    const a0 = +m[2], a1 = +m[3];
    if (a1 <= a0 || a1 - a0 > 30) continue;
    const num = [];
    for (let j = i + 1; j < L.length && num.length <= a1 - a0; j++) {
      const w = L[j].words[0];
      if (w?.small && /^\S{1,3}$/.test(w.text)) num.push(L[j]);
      else if (/^\d{1,3}:\d/.test(L[j].text)) break;
    }
    if (num.length !== a1 - a0 + 1) continue;
    const okN = num.filter((l, k) => +l.words[0].text === a0 + k).length;
    if (okN < Math.ceil(num.length / 2)) continue;   // 절반 넘게 맞을 때만 (엉뚱한 곳을 바꾸지 않게)
    num.forEach((l, k) => { l.words[0].text = String(a0 + k); Object.assign(l, lineOf(l.words)); });
  }
  // 같은 쪽 번호가 두 번 들어간 경우(여백에서 따로 찾은 것 + 다시 읽은 꼬리말) 하나만
  {
    const nums = L.filter(l => /^\s*\d{1,4}\s*$/.test(l.text));
    for (const a of nums) for (const b of nums) if (a !== b && !a._dup && !b._dup && a.text.trim() === b.text.trim() && Math.abs(a.y0 - b.y0) < hMed * 1.5 && Math.abs(a.x0 - b.x0) < hMed * 3) b._dup = true;
    // 글자가 거의 같은 줄이 같은 자리에 겹친 경우(꼬리말을 두 번 읽음)도 하나만
    const nt = (t) => t.replace(/[^0-9가-힣A-Za-z]/g, '');
    for (const a of L) for (const b of L) {
      if (a === b || a._dup || b._dup || Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) < hMed * 0.5) continue;
      if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) < (b.x1 - b.x0) * 0.5) continue;   // 같은 자리(가로로도 겹침)여야 한다 — 옆에 나란한 다른 줄은 중복이 아니다
      const A = nt(a.text), B = nt(b.text);
      if (B.length >= 3 && A.length >= B.length && A.includes(B.slice(0, Math.max(3, Math.floor(B.length * 0.8))))) b._dup = true;
    }
    L = L.filter(l => !l._dup);
  }
  // 3) 먹 진하기: 줄 상자 안 어두운 화소 비율 (굵은 글씨일수록 높다)
  for (const l of L) {
    let dark = 0, n = 0;
    const y0 = Math.max(0, Math.floor(l.y0)), y1 = Math.min(H, Math.ceil(l.y1)), x0 = Math.max(0, Math.floor(l.x0)), x1 = Math.min(W, Math.ceil(l.x1));
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 2) { n++; if (g[y * W + x] < 110) dark++; }
    l.ink = n ? dark / n : 0;
  }
  return L;
}

// ── 전체: 사진들 → 모델 ──
// 사진에서 잰 글자 사이 빈칸(띄어쓰기 증거): 낱말 사이 틈 · 낱말 안 글자 사이 틈(따로 읽힌 글자들 사이, 아니면 그림에서 잰 빈칸)
function spacingGeo(p, emPx, spaceT, spaceMed = null) {
  const g = p.g, W = p.w;
  const inkGap = (w, xa, xb) => {
    if (!g) return null;
    const x0 = Math.max(Math.round(w.x0) + 1, Math.round(xa)), x1 = Math.min(Math.round(w.x1) - 1, Math.round(xb));
    const y0 = Math.max(0, Math.round(w.y0)), y1 = Math.min(p.h - 1, Math.round(w.y1));
    if (x1 <= x0 || y1 <= y0) return 0;
    const vals = []; for (let y = y0; y <= y1; y += 2) for (let x = Math.round(w.x0); x <= Math.round(w.x1); x += 2) vals.push(g[y * W + x]);
    const t = Math.min(170, otsu(vals));
    let best = 0, run = 0;
    for (let x = x0; x <= x1; x++) {
      let dark = false;
      for (let y = y0; y <= y1; y++) if (g[y * W + x] < t) { dark = true; break; }
      run = dark ? 0 : run + 1; if (run > best) best = run;
    }
    return best;
  };
  const gapOf = (a, b) => (b.x0 - a.x1);
  return {
    gapOf,
    // 붙이기: 두 낱말 사이 틈이 띄어쓰기 문턱 근처(조금 넘는 정도)까지만
    joinOk: (a, b, sure) => { if (a.x1 == null || b.x0 == null) return null; if (globalThis.__koDbg) console.error('join', a.text, b.text, Math.round(gapOf(a, b)), Math.round(spaceT), !!sure); const gp = gapOf(a, b); if (spaceMed && gp > spaceMed * 0.8) return false; return gp < (sure ? Math.max(spaceT + emPx * 0.3, emPx * 0.55) : spaceT + emPx * 0.14); },
    // 띄우기: 그 자리 틈이 문턱 근처(조금 못 미치는 정도) 이상
    splitOk: (w, k) => {
      const c = (w.cuts || []).find(c => c.at === k);
      const need = Math.max(spaceT * 0.7, emPx * 0.2, spaceMed ? spaceMed * 0.6 : 0);
      if (c && c.gap != null) { if (globalThis.__koDbg) console.error('cut', w.text, k, Math.round(c.gap), Math.round(need)); return c.gap >= need; }
      if (w.x0 == null) return null;
      const n = [...w.text].length, cw = (w.x1 - w.x0) / n;
      const ink = inkGap(w, w.x0 + cw * (k - 0.6), w.x0 + cw * (k + 0.6));
      if (globalThis.__koDbg) console.error('ink', w.text, k, ink, Math.round(need), Math.round(emPx));
      return ink == null ? null : ink >= Math.max(need, emPx * 0.25);   // 그림에서 잰 빈칸은 글자 모양(ㄱ·ㅣ 옆 빈자리) 때문에 넓게 나오기 쉽다 → 더 엄하게
    },
  };
}
// 낱말 색(색 글씨, 띠 속 흰 글씨)을 글자 덩어리에 입힌다 — 낱말 글을 차례로 찾아 그 자리에서 나눈다
function colorRuns(runs, words) {
  const cw = (words || []).filter(w => w.color);
  if (!cw.length) return runs;
  // 줄 전체가 한 색이면 통째로
  const all = (words || []).filter(w => /[가-힣A-Za-z0-9]/.test(w.text));
  if (all.length && all.every(w => w.color === cw[0].color && !!w.inv === !!cw[0].inv)) return runs.map(r => ({ ...r, color: cw[0].color, ...(cw[0].inv && cw[0].bg ? { shade: cw[0].bg } : {}) }));
  const out = []; let k = 0;
  for (const r of runs) {
    let t = r.text, pos = 0;
    while (k < cw.length) {
      const i = t.indexOf(cw[k].text, pos);
      if (i < 0) break;
      if (i > pos) out.push({ ...r, text: t.slice(pos, i) });
      out.push({ ...r, text: cw[k].text, color: cw[k].color, ...(cw[k].inv && cw[k].bg ? { shade: cw[k].bg } : {}) });
      pos = i + cw[k].text.length; k++;
    }
    if (pos < t.length) out.push({ ...r, text: t.slice(pos) });
  }
  return out;
}
// 고친 낱말에 표시(바탕색) — 한 줄의 글자 덩어리들을 고친 낱말 자리에서 나눈다
function markFixRuns(runs, words) {
  const fixed = (words || []).filter(w => w.fixed);
  if (!fixed.length) return runs;
  const out = [];
  let k = 0;
  for (const r of runs) {
    let t = r.text, pos = 0;
    while (k < fixed.length) {
      const i = t.indexOf(fixed[k].text, pos);
      if (i < 0) break;
      if (i > pos) out.push({ ...r, text: t.slice(pos, i) });
      out.push({ ...r, text: fixed[k].text, shade: fixed[k].fixed === 'typo' ? 'FFF09A' : 'BFEFC0' });
      pos = i + fixed[k].text.length; k++;
    }
    if (pos < t.length) out.push({ ...r, text: t.slice(pos) });
  }
  return out;
}

// 그림(삽화·사진·QR 코드) 찾기: 또렷이 읽힌 글자를 지우고 남은 잉크가 크게 뭉친 자리.
//  그 자리의 색 그림을 오려(종이 색을 희게 맞춰) 돌려주고, 그 안에서 글로 잘못 읽힌 조각은 버린다
// 꾸밈 층: 색 그림에서 종이를 흰색으로 고르고(조명 얼룩·그늘 지움) 읽어 낸 글자를 지운 뒤, 남은 것(띠·색 상자·그림·표 선·읽지 못한 글)을
//  덩어리마다 오려 '글 뒤 그림'으로 돌려준다. 띠·상자·그림을 따로따로 알아맞히는 대신 사진에 있는 그대로 깐다.
//  돌려주는 값: [{ x0, y0, x1, y1, rgb, pxW, pxH, behind: true }]
function designLayer(part, lines) {
  const P = part.planes; if (!P) return null;
  if (!part.pageFound) return null;   // 쪽을 못 찾은 사진(책상·손이 함께 든 사진)은 꾸밈 층을 만들지 않는다
  const [R, G, B] = P, W = part.w, H = part.h, N = W * H;
  const all = lines.flatMap(l => l.words || []).filter(w => w.x0 != null);
  const hs = all.filter(w => /[가-힣]/.test(w.text) && (w.conf ?? 100) >= 60).map(w => w.y1 - w.y0).sort((a, b) => a - b);
  const em = hs[hs.length >> 1] || Math.max(16, W / 45);
  // 1) 종이 밝기 면: 칸마다 밝은 쪽 값 → 색 없는 칸만 골라 매끈한 2차 면으로 맞춘다(상자·그림은 면 아래로 벗어나므로 빠진다)
  const cs = Math.max(8, Math.round(W / 64)), gw = Math.ceil(W / cs), gh = Math.ceil(H / cs);
  const Lc = new Float32Array(gw * gh), Sc = new Float32Array(gw * gh), Cc = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const v = [];
    for (let y = gy * cs; y < Math.min(H, gy * cs + cs); y += 2) for (let x = gx * cs; x < Math.min(W, gx * cs + cs); x += 2) { const i = y * W + x; v.push([0.3 * R[i] + 0.59 * G[i] + 0.11 * B[i], R[i], G[i], B[i]]); }
    v.sort((a, b) => a[0] - b[0]);
    const q = v[Math.floor(v.length * 0.8)] || [0, 0, 0, 0], k = gy * gw + gx;
    Lc[k] = q[0]; Sc[k] = Math.max(q[1], q[2], q[3]) - Math.min(q[1], q[2], q[3]); Cc[0][k] = q[1]; Cc[1][k] = q[2]; Cc[2][k] = q[3];
  }
  const cand = []; for (let k = 0; k < gw * gh; k++) if (Sc[k] < 24 && Lc[k] > 70) cand.push(k);
  const fitQuad = (ks) => {   // 최소제곱: L = a + bx + cy + dxx + eyy + fxy
    const A = Array.from({ length: 6 }, () => new Float64Array(7));
    for (const k of ks) { const x = (k % gw) / gw - 0.5, y = ((k / gw) | 0) / gh - 0.5, f = [1, x, y, x * x, y * y, x * y]; for (let i = 0; i < 6; i++) { for (let j = 0; j < 6; j++) A[i][j] += f[i] * f[j]; A[i][6] += f[i] * Lc[k]; } }
    for (let i = 0; i < 6; i++) { let m = i; for (let r = i + 1; r < 6; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r; [A[i], A[m]] = [A[m], A[i]]; if (Math.abs(A[i][i]) < 1e-9) return null; for (let r = 0; r < 6; r++) { if (r === i) continue; const t = A[r][i] / A[i][i]; for (let j = i; j < 7; j++) A[r][j] -= t * A[i][j]; } }
    const c = A.map((row, i) => row[6] / row[i]);
    return (gx, gy) => { const x = gx / gw - 0.5, y = gy / gh - 0.5; return c[0] + c[1] * x + c[2] * y + c[3] * x * x + c[4] * y * y + c[5] * x * y; };
  };
  let paperOK = cand.length >= gw * gh * 0.25, surf = null, keep = cand;
  if (paperOK) {
    // 처음엔 밝은 절반으로 시작(상자가 섞이면 면이 아래로 끌려간다)
    const srt = cand.map(k => Lc[k]).sort((a, b) => a - b), med = srt[srt.length >> 1];
    keep = cand.filter(k => Lc[k] >= med * 0.9);
    for (let it = 0; it < 5 && keep.length >= 30; it++) {
      const f = fitQuad(keep); if (!f) break; surf = f;
      const nk = cand.filter(k => { const r = Lc[k] / Math.max(1, f(k % gw, (k / gw) | 0)); return r > 0.955 && r < 1.06; });
      if (nk.length < 30) break; keep = nk;
    }
    if (!surf || keep.length < gw * gh * 0.2) paperOK = false;
  }
  const out = [];
  const clean = [new Uint8Array(N), new Uint8Array(N), new Uint8Array(N)];
  if (paperOK) {
    // 가장자리 그늘(제본 쪽·말린 쪽): 세로 띠마다 종이 칸들의 (실제 ÷ 면) 가운데값 — 매끈하게 변하는 것만 그늘로 본다
    const col = new Float32Array(gw).fill(1);
    for (let gx = 0; gx < gw; gx++) {
      const rs = []; for (let gy = 0; gy < gh; gy++) { const k = gy * gw + gx; if (Sc[k] < 24) { const r = Lc[k] / Math.max(1, surf(gx, gy)); if (r > 0.6 && r < 1.08) rs.push(r); } }
      rs.sort((a, b) => a - b); if (rs.length >= gh * 0.5) col[gx] = rs[Math.floor(rs.length * 0.7)];
    }
    for (let gx = 0; gx < gw; gx++) if (gx > gw * 0.12 && gx < gw * 0.88) col[gx] = Math.max(col[gx], 0.985);   // 가운데는 그늘이 없다(넓은 상자를 그늘로 지우지 않게)
    const wb = [0, 1, 2].map(ch => { const v = keep.map(k => Cc[ch][k] / Math.max(1, Lc[k])).sort((a, b) => a - b); return v[v.length >> 1] || 1; });
    const bgAt = (x, y) => { const fx = Math.min(gw - 1.001, Math.max(0, x / cs - 0.5)), x0 = Math.floor(fx), t = fx - x0; return Math.max(40, surf(x / cs - 0.5, y / cs - 0.5) * (col[x0] * (1 - t) + col[Math.min(gw - 1, x0 + 1)] * t)); };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, bg = (x & 7) === 0 || x === 0 ? (designLayer._bg = bgAt(x, y)) : designLayer._bg;
      for (let ch = 0; ch < 3; ch++) clean[ch][i] = Math.min(255, Math.round(P[ch][i] * 248 / (bg * wb[ch])));
    }
  } else { for (let ch = 0; ch < 3; ch++) clean[ch].set(P[ch]); }
  // 2) 읽어 낸 낱말 지우기: 낱말 네모 둘레의 색(가운데값)으로 칠한다 — 종이 위면 흰색, 띠·상자 위면 그 색
  const medOf = (a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 255; };
  const rects = [];
  for (const l of lines) {
    const ws = (l.words || []).filter(w => w.x0 != null);
    if (l.x0 == null || l.y1 - l.y0 > em * 5) continue;
    if (!ws.length || ws.length < (l.words || []).length) { rects.push([l.x0, l.y0, l.x1, l.y1]); continue; }   // 자리 없는 낱말(다시 읽어 바꾼 것)이 섞인 줄은 줄 네모 통째로
    ws.sort((a, b) => a.x0 - b.x0);
    const ly0 = Math.min(l.y0, ...ws.map(w => w.y0)), ly1 = Math.max(l.y1, ...ws.map(w => w.y1));
    let cur = [ws[0].x0, ly0, ws[0].x1, ly1];
    for (let k = 1; k < ws.length; k++) {
      if (ws[k].x0 - cur[2] < em * 1.6) cur[2] = Math.max(cur[2], ws[k].x1);   // 낱말 사이 틈까지 이어서 지운다(획 끝이 남지 않게)
      else { rects.push(cur); cur = [ws[k].x0, ly0, ws[k].x1, ly1]; }
    }
    rects.push(cur);
  }
  for (const q of rects) {
    const mx = em * 0.2, my = em * 0.28, x0 = Math.max(0, Math.floor(q[0] - mx)), y0 = Math.max(0, Math.floor(q[1] - my)), x1 = Math.min(W - 1, Math.ceil(q[2] + mx)), y1 = Math.min(H - 1, Math.ceil(q[3] + my));
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    // 긴 줄은 토막마다 그 둘레 색으로(상자 안팎에 걸친 줄·그늘진 줄)
    const seg = Math.max(1, Math.round((x1 - x0) / (em * 4)));
    for (let k = 0; k < seg; k++) {
      const sx0 = Math.round(x0 + (x1 - x0) * k / seg), sx1 = Math.round(x0 + (x1 - x0) * (k + 1) / seg);
      const ring = [[], [], []], st = Math.max(1, Math.round((sx1 - sx0) / 30));
      for (let x = sx0; x <= sx1; x += st) for (const y of [y0, y1]) { const i = y * W + x; for (let ch = 0; ch < 3; ch++) ring[ch].push(clean[ch][i]); }
      const c = ring.map(medOf);
      for (let y = y0; y <= y1; y++) for (let x = sx0; x <= sx1; x++) { const i = y * W + x; clean[0][i] = c[0]; clean[1][i] = c[1]; clean[2][i] = c[2]; }
    }
  }
  // 3) 종이(거의 흰 점)는 흰색으로, 나머지가 꾸밈
  const c = 4, cw = Math.ceil(W / c), ch_ = Math.ceil(H / c), ink = new Uint8Array(cw * ch_);
  const isDesign = (i) => { const r = clean[0][i], g = clean[1][i], b = clean[2][i], mx = Math.max(r, g, b), mn = Math.min(r, g, b); return paperOK ? (0.3 * r + 0.59 * g + 0.11 * b < 218 || mx - mn > 26) : true; };
  if (paperOK) for (let i = 0; i < N; i++) if (!isDesign(i)) { clean[0][i] = 255; clean[1][i] = 255; clean[2][i] = 255; }
  if (paperOK) {
    // 가장자리 정리: (가) 가장자리에서 이어진 살색(책을 쥔 손) (나) 가장자리 띠 안의 색 없는 회색(제본 쪽 그늘·옆 쪽·책 두께)은 지운다
    const k2 = 8, kw = Math.ceil(W / k2), kh = Math.ceil(H / k2), skin = new Uint8Array(kw * kh), seen = new Uint8Array(kw * kh);
    for (let gy = 0; gy < kh; gy++) for (let gx = 0; gx < kw; gx++) {
      let n = 0, sk = 0, gr = 0;
      for (let y = gy * k2; y < Math.min(H, gy * k2 + k2); y += 2) for (let x = gx * k2; x < Math.min(W, gx * k2 + k2); x += 2) {
        const i = y * W + x, r = clean[0][i], g = clean[1][i], b = clean[2][i]; n++;
        if (r === 255 && g === 255 && b === 255) continue;
        if (r - g >= 10 && r - b >= 28 && g >= b - 4) sk++; else if (Math.max(r, g, b) - Math.min(r, g, b) < 34) gr++;
      }
      const nearEdge = gx < kw * 0.05 || gx >= kw * 0.95 || gy < kh * 0.025 || gy >= kh * 0.975;
      skin[gy * kw + gx] = sk * 2 >= n ? 1 : (nearEdge && (gr + sk) * 3 >= n ? 2 : 0);
    }
    const wipe = (gx, gy) => { for (let y = Math.max(0, gy * k2 - k2); y < Math.min(H, gy * k2 + 2 * k2); y++) for (let x = Math.max(0, gx * k2 - k2); x < Math.min(W, gx * k2 + 2 * k2); x++) { const i = y * W + x; clean[0][i] = 255; clean[1][i] = 255; clean[2][i] = 255; } };
    // 제본 쪽(펼친 책의 안쪽) 띠는 그늘·옆 쪽이 비치므로 통째로 비운다
    if (part.side === 'L' || part.side === 'R') {
      const bw = Math.round(W * 0.05), xa = part.side === 'L' ? W - bw : 0;
      for (let y = 0; y < H; y++) for (let x = xa; x < xa + bw; x++) { const i = y * W + x; clean[0][i] = 255; clean[1][i] = 255; clean[2][i] = 255; }
    }
    const st = [];
    for (let gx = 0; gx < kw; gx++) for (const gy of [0, 1, kh - 2, kh - 1]) if (skin[gy * kw + gx]) st.push(gy * kw + gx);
    for (let gy = 0; gy < kh; gy++) for (const gx of [0, 1, kw - 2, kw - 1]) if (skin[gy * kw + gx]) st.push(gy * kw + gx);
    for (const k of st) seen[k] = 1;
    while (st.length) {
      const k = st.pop(), x = k % kw, y = (k / kw) | 0; wipe(x, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= kw || Y >= kh) continue; const q = Y * kw + X; if (seen[q] || !skin[q]) continue; seen[q] = 1; st.push(q); }
    }
  }
  if (!paperOK) {
    // 종이가 안 보이는 쪽(쪽 전체가 색 바탕): 쪽 전체를 그림 한 장으로
    out.push({ x0: 0, y0: 0, x1: W, y1: H, whole: true });
  } else {
    for (let gy = 0; gy < ch_; gy++) for (let gx = 0; gx < cw; gx++) {
      let n = 0, k = 0;
      for (let y = gy * c; y < Math.min(H, gy * c + c); y += 2) for (let x = gx * c; x < Math.min(W, gx * c + c); x += 2) { k++; if (clean[0][y * W + x] !== 255 || clean[1][y * W + x] !== 255 || clean[2][y * W + x] !== 255) n++; }
      ink[gy * cw + gx] = n * 2 >= k ? 1 : 0;
    }
    const r = Math.max(2, Math.round(em * 0.5 / c)), tmp = new Uint8Array(cw * ch_), dil = new Uint8Array(cw * ch_);
    for (let y = 0; y < ch_; y++) { let last = -1e9; for (let x = 0; x < cw; x++) { if (ink[y * cw + x]) last = x; if (x - last <= r) tmp[y * cw + x] = 1; } last = 1e9; for (let x = cw - 1; x >= 0; x--) { if (ink[y * cw + x]) last = x; if (last - x <= r) tmp[y * cw + x] = 1; } }
    for (let x = 0; x < cw; x++) { let last = -1e9; for (let y = 0; y < ch_; y++) { if (tmp[y * cw + x]) last = y; if (y - last <= r) dil[y * cw + x] = 1; } last = 1e9; for (let y = ch_ - 1; y >= 0; y--) { if (tmp[y * cw + x]) last = y; if (last - y <= r) dil[y * cw + x] = 1; } }
    const lab = new Int32Array(cw * ch_), regs = [];
    for (let i0 = 0; i0 < dil.length; i0++) {
      if (!dil[i0] || lab[i0]) continue;
      const id = regs.length + 1, st = [i0]; lab[i0] = id; let x0 = cw, x1 = 0, y0 = ch_, y1 = 0, n = 0;
      while (st.length) { const k = st.pop(), x = k % cw, y = (k / cw) | 0; n += ink[k]; if (ink[k]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } for (const q of [k - 1, k + 1, k - cw, k + cw]) { if (q < 0 || q >= dil.length || lab[q] || !dil[q]) continue; if ((q === k - 1 && x === 0) || (q === k + 1 && x === cw - 1)) continue; lab[q] = id; st.push(q); } }
      regs.push({ id, x0: x0 * c, y0: y0 * c, x1: Math.min(W, (x1 + 1) * c), y1: Math.min(H, (y1 + 1) * c), n });
    }
    for (const q of regs) {
      const bw = q.x1 - q.x0, bh = q.y1 - q.y0, inkPx = q.n * c * c;
      if (Math.max(bw, bh) < em * 2.2 || inkPx < em * em * 0.5) continue;      // 점·얼룩·글자 한두 자 크기
      if (Math.min(bw, bh) < em * 0.22) continue;                                 // 가는 줄은 선으로 따로 긋는다
      // 사진 가장자리에 붙은 가늘고 긴 것(책등 그늘·옆 쪽·책상)은 뺀다
      const edge = q.x0 < W * 0.012 || q.x1 > W * 0.988 || q.y0 < H * 0.012 || q.y1 > H * 0.988;
      // 덩어리의 색: 살색(손)·색 없는 옅은 회색(그늘)인지
      let nn = 0, skin = 0, sat = 0, lum = 0;
      for (let y = q.y0; y < q.y1; y += 3) for (let x = q.x0; x < q.x1; x += 3) {
        if (lab[((y / c) | 0) * cw + ((x / c) | 0)] !== q.id) continue;
        const i = y * W + x, r = clean[0][i], g = clean[1][i], b = clean[2][i]; if (r === 255 && g === 255 && b === 255) continue;
        nn++; if (r - g >= 12 && r - b >= 35 && g >= b) skin++; sat += Math.max(r, g, b) - Math.min(r, g, b); lum += 0.3 * r + 0.59 * g + 0.11 * b;
      }
      if (!nn) continue;
      if (skin > nn * 0.5 && (edge || bw * bh > W * H * 0.02)) continue;       // 손
      if (edge && (Math.min(bw, bh) < em * 2.5 || sat / nn < 40)) continue;   // 가장자리에 붙은 것은 색이 뚜렷한 것(띠)만 — 가는 것·회색 그늘·옆 쪽은 뺀다
      if (bw * bh > N * 0.45) continue;   // 쪽의 절반 가까이를 덮는 덩어리는 그늘·손까지 한데 붙은 것 — 믿지 않는다
      if (edge && bh > H * 0.6 && bw < W * 0.2) continue;   // 옆 가장자리를 따라 선 긴 띠(옆 쪽·책상·책 두께)
      const mSat = sat / nn, mLum = lum / nn, dens = inkPx / (bw * bh);
      if (mSat < 30 && Math.min(bw, bh) < em * 2 && Math.max(bw, bh) > em * 10) continue;   // 색 없는 길고 가는 것(그늘 줄·책 두께)
      // 이 쪽이 '꾸민 쪽'인지: 색이 뚜렷한 덩어리(띠·색 상자·색 그림)나 짙은 그림(QR·사진)이 하나라도 있어야 한다
      const strong = (bw * bh >= N * 0.012 && mSat >= 30) || (bw >= em * 3.5 && bh >= em * 3.5 && dens >= 0.35 && mLum < 150);
      out.push({ x0: q.x0, y0: q.y0, x1: q.x1, y1: q.y1, id: q.id, lab, cw, c, strong });
    }
    // 쪽의 절반 넘게 덮으면(잘못 고른 종이 면·그늘) 믿지 않는다
    const cov = out.reduce((a, q) => a + (q.x1 - q.x0) * (q.y1 - q.y0), 0);
    if (cov > N * 1.6) return null;
    // 글만 있는 쪽(색 띠·그림이 없는 쪽)은 예전 방식 그대로 둔다 — 그늘이나 읽다 만 글 조각을 그림으로 깔지 않는다
    if (!out.some(q => q.strong)) return null;
  }
  // 4) 덩어리마다 오려 내기(다른 덩어리·종이는 흰색), 큰 것은 줄인다
  const res = [];
  for (const q of out) {
    const x0 = Math.floor(q.x0), y0 = Math.floor(q.y0), w = Math.floor(q.x1 - q.x0), h = Math.floor(q.y1 - q.y0);
    if (w < 4 || h < 4) continue;
    const f = Math.max(1, Math.ceil(Math.max(w, h) / (q.whole ? 1300 : 1100))), ow = Math.floor(w / f), oh = Math.floor(h / f);
    if (ow < 2 || oh < 2) continue;
    const rgb = new Uint8Array(ow * oh * 3);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
      const acc = [0, 0, 0]; let n = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
        const X = x0 + x * f + dx, Y = y0 + y * f + dy, i = Y * W + X; n++;
        if (q.lab && q.lab[((Y / q.c) | 0) * q.cw + ((X / q.c) | 0)] !== q.id) { acc[0] += 255; acc[1] += 255; acc[2] += 255; continue; }
        acc[0] += clean[0][i]; acc[1] += clean[1][i]; acc[2] += clean[2][i];
      }
      const o = (y * ow + x) * 3; rgb[o] = Math.round(acc[0] / n); rgb[o + 1] = Math.round(acc[1] / n); rgb[o + 2] = Math.round(acc[2] / n);
    }
    res.push({ x0, y0, x1: x0 + w, y1: y0 + h, rgb, pxW: ow, pxH: oh, behind: true, whole: !!q.whole });
  }
  if (globalThis.process?.env?.LAYDBG) {
    const fs = globalThis.__layFs; if (fs) { const buf = Buffer.alloc(N * 3); for (let i = 0; i < N; i++) { buf[i * 3] = clean[0][i]; buf[i * 3 + 1] = clean[1][i]; buf[i * 3 + 2] = clean[2][i]; } fs.writeFileSync(`${globalThis.process.env.LAYDBG}_${designLayer._n = (designLayer._n || 0) + 1}.ppm`, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), buf])); }
    console.error('LAYER', W, H, 'paper', paperOK, 'em', Math.round(em), res.map(q => [Math.round(q.x0 / W * 100), Math.round(q.y0 / H * 100), Math.round((q.x1 - q.x0) / W * 100), Math.round((q.y1 - q.y0) / H * 100)].join(',')).join(' | '));
  }
  return res;
}
function findPictures(part, lines) {
  const P = part.planes; if (!P) return { lines, pics: [] };
  const [R, G, B, MK] = P, W = part.w, H = part.h, g = part.g;
  const all = lines.flatMap(l => l.words || []).filter(w => w.x0 != null);
  const hs = all.filter(w => /[가-힣]/.test(w.text) && (w.conf ?? 100) >= 60).map(w => w.y1 - w.y0).sort((a, b) => a - b);
  const em = hs[hs.length >> 1] || 28;
  const cx = all.filter(w => (w.conf ?? 100) >= 60 && /[가-힣A-Za-z\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]{2}/.test(w.text)), sx0 = cx.map(w => w.x0).sort((a, b) => a - b), sx1 = cx.map(w => w.x1).sort((a, b) => a - b);
  const TX0 = sx0.length >= 20 ? sx0[Math.floor(sx0.length * 0.03)] : 0, TX1 = sx1.length >= 20 ? sx1[Math.floor(sx1.length * 0.97)] : W;
  const c = 4, gw = Math.ceil(W / c), gh = Math.ceil(H / c), ink = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let n = 0, k = 0;
    for (let y = gy * c; y < Math.min(H, gy * c + c); y += 2) for (let x = gx * c; x < Math.min(W, gx * c + c); x += 2) {
      const i = y * W + x; k++;
      // 잉크: 어두운 점, 또는 색이 짙은 점(옅은 색 삽화) — 뒤집어 읽은 띠는 그림이 아니다
      if (MK[i] > 128) continue;
      if (g[i] < 120) n++; else { const mx = Math.max(R[i], G[i], B[i]), mn = Math.min(R[i], G[i], B[i]); if (mx - mn > 70 && mx < 235) n++; }
    }
    ink[gy * gw + gx] = n * 4 >= k ? 1 : 0;
  }
  const ink0 = new Uint8Array(ink);
  // 흐리게라도 '글'로 읽힌 자리(나중에 그 덩어리가 그림인지 흐린 글인지 가릴 때 쓴다)
  const txt = new Uint8Array(gw * gh);
  for (const w of all) {
    if (!/[가-힣A-Za-z\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]{2}/.test(w.text) || w.y1 - w.y0 > em * 2.2) continue;
    for (let gy = Math.max(0, Math.floor(w.y0 / c)); gy <= Math.min(gh - 1, Math.floor(w.y1 / c)); gy++) for (let gx = Math.max(0, Math.floor(w.x0 / c)); gx <= Math.min(gw - 1, Math.floor(w.x1 / c)); gx++) txt[gy * gw + gx] = 1;
  }
  // 또렷이 읽힌 낱말 자리는 지운다(글자는 그림이 아니다)
  const lineConf = (l) => { const ws = (l.words || []).filter(w => w.conf != null); return ws.length ? ws.reduce((a, w) => a + w.conf * [...w.text].length, 0) / ws.reduce((a, w) => a + [...w.text].length, 0) : 100; };
  for (const l of lines) {
    const lc = lineConf(l);
    for (const w of l.words || []) {
      if (w.x0 == null) continue;
      const wordy = /[가-힣A-Za-z\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]{2}/.test(w.text) || (/[가-힣A-Za-z0-9\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(w.text) && lc >= 75);
      if (!(wordy && (w.conf ?? 100) >= 60) && !(lc >= 80 && (w.conf ?? 100) >= 40)) continue;
      if (w.y1 - w.y0 > em * 3) continue;
      const m = em * 0.12;
      for (let gy = Math.max(0, Math.floor((w.y0 - m) / c)); gy <= Math.min(gh - 1, Math.floor((w.y1 + m) / c)); gy++) for (let gx = Math.max(0, Math.floor((w.x0 - m) / c)); gx <= Math.min(gw - 1, Math.floor((w.x1 + m) / c)); gx++) ink[gy * gw + gx] = 0;
    }
  }
  // 가까운 잉크끼리 잇기(네모 넓히기) 뒤 덩어리 나누기
  const r = Math.max(2, Math.round(em * 0.55 / c)), tmp = new Uint8Array(gw * gh), dil = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) { let last = -1e9; for (let x = 0; x < gw; x++) { if (ink[y * gw + x]) last = x; if (x - last <= r) tmp[y * gw + x] = 1; } last = 1e9; for (let x = gw - 1; x >= 0; x--) { if (ink[y * gw + x]) last = x; if (last - x <= r) tmp[y * gw + x] = 1; } }
  for (let x = 0; x < gw; x++) { let last = -1e9; for (let y = 0; y < gh; y++) { if (tmp[y * gw + x]) last = y; if (y - last <= r) dil[y * gw + x] = 1; } last = 1e9; for (let y = gh - 1; y >= 0; y--) { if (tmp[y * gw + x]) last = y; if (last - y <= r) dil[y * gw + x] = 1; } }
  const lab = new Uint8Array(gw * gh), regs = [];
  for (let i0 = 0; i0 < dil.length; i0++) {
    if (!dil[i0] || lab[i0]) continue;
    const st = [i0]; lab[i0] = 1; let x0 = gw, x1 = 0, y0 = gh, y1 = 0, n = 0, area = 0, nt = 0;
    while (st.length) { const k = st.pop(), x = k % gw, y = (k / gw) | 0; area++; n += ink[k]; if (ink[k] && txt[k]) nt++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; for (const q of [k - 1, k + 1, k - gw, k + gw]) { if (q < 0 || q >= dil.length || lab[q] || !dil[q]) continue; if ((q === k - 1 && x === 0) || (q === k + 1 && x === gw - 1)) continue; lab[q] = 1; st.push(q); } }
    regs.push({ x0: (x0 + r) * c, y0: (y0 + r) * c, x1: (x1 + 1 - r) * c, y1: (y1 + 1 - r) * c, n, area, nt });
  }
  const scriptPage = all.filter(w => /[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]{2}/.test(w.text)).length >= 3;
  const pics = [];
  for (const q of regs) {
    const bw = q.x1 - q.x0, bh = q.y1 - q.y0;
    // 글자 서너 자 크기는 넘어야 하고(작은 기호·점은 뺀다), 가는 줄이 아니며, 잉크가 넉넉해야 한다
    if (bw < em * 3.2 || bh < em * 3.2 || q.n * c * c < bw * bh * 0.12) continue;
    // 남은 잉크의 절반 넘게가 (흐리게라도) 글로 읽힌 자리면 그림이 아니라 흐린 글이다
    if (q.nt > q.n * 0.5) continue;
    // 원어(헬라어·히브리어) 낱말이 읽힌 자리는 그림으로 돌리지 않는다(행간 대역 본문 등 — 글로 살려 둔다)
    if (all.filter(w => /[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]{2}/.test(w.text) && (w.x0 + w.x1) / 2 > q.x0 && (w.x0 + w.x1) / 2 < q.x1 && (w.y0 + w.y1) / 2 > q.y0 && (w.y0 + w.y1) / 2 < q.y1).length >= 1) continue;
    // 원어가 섞인 쪽(주석·대역 본문)에서는 아주 짙은 덩어리(사진·QR)만 그림으로 본다 — 큰 원어 글자가 그림으로 빠지지 않게
    if (scriptPage && q.n * c * c < bw * bh * 0.35) continue;
    // 글 판면 바깥(옆 쪽·표지 날개)에 있는 것은 뺀다
    if (q.x1 < TX0 - em || q.x0 > TX1 + em) continue;
    // 사진 가장자리에 닿은 것은 손·배경·옆 쪽이다
    if (q.x0 < W * 0.012 || q.y0 < H * 0.012 || q.x1 > W * 0.988 || q.y1 > H * 0.988) continue;
    if (bw * bh > W * H * 0.45) continue;
    if (globalThis.process?.env?.PICDBG) console.error('PIC', Math.round(q.x0 / W * 100), Math.round(q.y0 / H * 100), Math.round(bw / W * 100), Math.round(bh / H * 100), 'ink', (q.n * c * c / (bw * bh)).toFixed(2), 'txt', (q.nt / q.n).toFixed(2));
    pics.push({ x0: Math.max(0, q.x0 - em * 0.1), y0: Math.max(0, q.y0 - em * 0.1), x1: Math.min(W, q.x1 + em * 0.1), y1: Math.min(H, q.y1 + em * 0.1) });
  }
  if (!pics.length) return { lines, pics: [] };
  // 그림 안에서 읽힌 조각은 버린다(그림에 박힌 글자는 그림으로 남는다)
  const inPic = (w) => !((w.conf ?? 100) >= 60 && /[가-힣A-Za-z\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]{2}/.test(w.text)) && pics.some(q => (w.x0 + w.x1) / 2 > q.x0 && (w.x0 + w.x1) / 2 < q.x1 && (w.y0 + w.y1) / 2 > q.y0 && (w.y0 + w.y1) / 2 < q.y1);
  const out = [];
  for (const l of lines) {
    const ws = (l.words || []).filter(w => w.x0 == null || !inPic(w));
    if (ws.length === (l.words || []).length) { out.push(l); continue; }
    if (!ws.length) continue;
    out.push({ ...l, words: ws, text: ws.map(w => w.text).join(' '), x0: Math.min(...ws.map(w => w.x0)), x1: Math.max(...ws.map(w => w.x1)), y0: Math.min(...ws.map(w => w.y0)), y1: Math.max(...ws.map(w => w.y1)) });
  }
  // 오려 내기: 너무 크면 줄이고, 종이 색(밝은 쪽)이 흰색이 되게 색 성분마다 맞춘다
  for (const q of pics) {
    const x0 = Math.floor(q.x0), y0 = Math.floor(q.y0), w = Math.ceil(q.x1) - x0, h = Math.ceil(q.y1) - y0;
    const f = Math.max(1, Math.ceil(Math.max(w, h) / 800)), ow = Math.floor(w / f), oh = Math.floor(h / f);
    const rgb = new Uint8Array(ow * oh * 3), hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
      const acc = [0, 0, 0]; let n = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) { const i = (y0 + y * f + dy) * W + x0 + x * f + dx; acc[0] += R[i]; acc[1] += G[i]; acc[2] += B[i]; n++; }
      for (let ch = 0; ch < 3; ch++) { const v = Math.round(acc[ch] / n); rgb[(y * ow + x) * 3 + ch] = v; hist[ch][v]++; }
    }
    const gain = hist.map(hh => { let a = 0, v = 255; for (; v > 60; v--) { a += hh[v]; if (a >= ow * oh * 0.05) break; } return Math.min(1.7, 250 / Math.max(60, v)); });
    for (let i = 0; i < rgb.length; i++) rgb[i] = Math.min(255, Math.round(rgb[i] * gain[i % 3]));
    q.rgb = rgb; q.pxW = ow; q.pxH = oh;
  }
  return { lines: out, pics };
}
// 두 단으로 짠 쪽: 글자 인식은 두 단을 가로질러 한 줄로 읽는다 → 단 사이 빈 띠를 찾아 줄을 둘로 가르고 단 번호를 붙인다.
//  돌려주는 값: { lines(줄마다 zone·col), zones: [{ y0, y1, g0, g1 }] } — 제목처럼 띠를 가로지르는 줄은 그대로(통단)
function splitColumns(lines, W, H) {
  const wordy = (w) => /[가-힣A-Za-z0-9\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(w.text) && w.x0 != null;
  const body = lines.filter(l => l.y0 > H * 0.06 && l.y1 < H * 0.95);
  const ws = body.flatMap(l => (l.words || []).filter(w => wordy(w) && (w.conf ?? 100) >= 40));
  if (ws.length < 60 || body.length < 10) return { lines, zones: [] };
  const hs = ws.filter(w => /[가-힣]/.test(w.text)).map(w => w.y1 - w.y0).sort((a, b) => a - b), em = hs[hs.length >> 1] || 24;
  const xs0 = ws.map(w => w.x0).sort((a, b) => a - b), xs1 = ws.map(w => w.x1).sort((a, b) => a - b);
  const X0 = xs0[Math.floor(xs0.length * 0.03)], X1 = xs1[Math.floor(xs1.length * 0.97)];
  if (X1 - X0 < em * 24) return { lines, zones: [] };   // 두 단이 들어갈 폭이 아니다
  // 줄마다 가운데 언저리의 가장 넓은 낱말 틈(한 글자 넘는 것)을 모아, 그 틈들이 위에서 아래로 한 줄(조금 기울어도 됨)에 늘어서면 단 사이 띠다
  const R = X1 - X0, pts = [];
  for (const l of body) {
    const lw = (l.words || []).filter(w => w.x0 != null).sort((a, b) => a.x0 - b.x0);   // 흐리게 읽힌 낱말도 자리는 차지한다(빼면 없는 틈이 생긴다)
    let bestG = null;
    for (let i = 1; i < lw.length; i++) {
      const g = lw[i].x0 - lw[i - 1].x1, c = (lw[i].x0 + lw[i - 1].x1) / 2;
      if (g >= em * 1.0 && c > X0 + R * 0.3 && c < X0 + R * 0.7 && (!bestG || g > bestG.g)) bestG = { g, c, y: (l.y0 + l.y1) / 2 };
    }
    if (bestG) pts.push(bestG);
  }
  let best = null;
  if (pts.length >= 5) {
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      if (Math.abs(pts[j].y - pts[i].y) < H * 0.12) continue;
      const b = (pts[j].c - pts[i].c) / (pts[j].y - pts[i].y); if (Math.abs(b) > 0.1) continue;
      const a = pts[i].c - b * pts[i].y;
      const inl = pts.filter(q => Math.abs(q.c - (a + b * q.y)) < Math.min(q.g * 0.45, em * 1.2));
      if (!best || inl.length > best.inl.length) best = { a, b, inl };
    }
    if (best && best.inl.length >= 5) {
      // 맞는 점들로 다시 맞춘다
      const n = best.inl.length, my = best.inl.reduce((s2, q) => s2 + q.y, 0) / n, mc = best.inl.reduce((s2, q) => s2 + q.c, 0) / n;
      let syy = 0, syc = 0; for (const q of best.inl) { syy += (q.y - my) ** 2; syc += (q.y - my) * (q.c - mc); }
      const b = syy > 0 ? syc / syy : 0; best = { a: mc - b * my, b, inl: best.inl };
    } else best = null;
  }
  if (globalThis.process?.env?.COLDBG) console.error('BAND', pts.length, best ? [Math.round(best.a), +best.b.toFixed(3), best.inl.length] : null, Math.round(X0), Math.round(X1), Math.round(em));
  if (!best) return { lines, zones: [] };
  const hw = Math.max(em * 0.3, Math.min(...best.inl.map(q => q.g)) * 0.3);
  const gmAt = (y) => best.a + best.b * y;
  // 띠를 가로지르는 줄(통단 제목 등)로 위아래 구역을 나눈다
  const mid = (l) => gmAt((l.y0 + l.y1) / 2);
  const crosses = (l) => { const gm = mid(l); return (l.words || []).some(w => wordy(w) && (w.conf ?? 100) >= 55 && w.x0 < gm - hw && w.x1 > gm + hw); };
  const sorted = body.slice().sort((a, b) => a.y0 - b.y0);
  const zones = []; let cur = [];
  const close = () => {
    if (cur.length) {
      const sideW = (l, side) => { const gm = mid(l); return (l.words || []).filter(w => wordy(w) && (side < 0 ? (w.x0 + w.x1) / 2 < gm : (w.x0 + w.x1) / 2 >= gm)); };
      const chars = (side) => cur.map(l => sideW(l, side).reduce((a, w) => a + [...w.text.replace(/\s/g, '')].length, 0)).filter(n => n > 0).sort((a, b) => a - b);
      const cl = chars(-1), cr = chars(1), md = (a) => a.length ? a[a.length >> 1] : 0;
      const both = cur.filter(l => sideW(l, -1).length && sideW(l, 1).length).length;
      const y0 = Math.min(...cur.map(l => l.y0)), y1 = Math.max(...cur.map(l => l.y1));
      if (globalThis.process?.env?.COLDBG) console.error('ZC', Math.round(y0), Math.round(y1), cl.length, cr.length, md(cl), md(cr), both);
      // 양쪽 다 글줄이 넉넉하고(쪽 번호·기호 칸이 아니고), 구역이 여러 줄 높이
      // 띠 자리를 (흐리게라도) 덮은 낱말이 있는 줄이 많으면 단 사이 띠가 아니다
      const covered = cur.filter(l => { const gm = mid(l); return (l.words || []).some(w => w.x0 != null && w.x0 < gm - hw * 0.5 && w.x1 > gm + hw * 0.5); }).length;
      // 원어 낱말이 줄줄이 든 구역(행간 대역 본문과 옆 번역 칸)은 단이 아니다
      const scriptLines = cur.filter(l => /[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]{2}/.test(l.text)).length;
      if (scriptLines < Math.max(3, cur.length * 0.25) && covered <= cur.length * 0.12 && cl.length >= 3 && cr.length >= 3 && md(cl) >= 6 && md(cr) >= 6 && Math.max(cl.length, cr.length) >= 5 && y1 - y0 > em * 6 && (both >= 2 || Math.min(cl.length, cr.length) >= 4)) zones.push({ y0, y1, lines: cur });
    }
    cur = [];
  };
  for (const l of sorted) { if (crosses(l)) close(); else cur.push(l); }
  close();
  if (!zones.length) return { lines, zones: [] };
  const out = [];
  for (const l of lines) {
    const zi = zones.findIndex(z => z.lines.includes(l));
    if (zi < 0) { out.push(l); continue; }
    const gm = mid(l);
    const wl = (l.words || []).filter(w => w.x0 == null || (w.x0 + w.x1) / 2 < gm), wr = (l.words || []).filter(w => w.x0 != null && (w.x0 + w.x1) / 2 >= gm);
    const mk = (ws2, col) => ({ ...l, words: ws2, text: ws2.map(w => w.text).join(' '), x0: Math.min(...ws2.map(w => w.x0)), x1: Math.max(...ws2.map(w => w.x1)), y0: Math.min(...ws2.map(w => w.y0)), y1: Math.max(...ws2.map(w => w.y1)), zone: zi, col });
    if (wl.length) out.push(mk(wl, 0));
    if (wr.length) out.push(mk(wr, 1));
  }
  return { lines: out, zones: zones.map(({ y0, y1 }) => ({ y0, y1, g0: gmAt((y0 + y1) / 2) - hw, g1: gmAt((y0 + y1) / 2) + hw })) };
}
// 글이 아닌 것을 글로 읽은 줄(굵은 선·무늬·QR 코드·그림): 확신이 바닥인 줄은 통째로, 또렷한 줄 양 끝에 붙은 바닥 조각은 그 조각만 버린다
function dropJunk(lines) {
  const cf = (w) => w.conf ?? 100, len = (w) => [...w.text].length;
  const out = [];
  for (const l of lines) {
    let ws = l.words || [];
    if (!ws.length || ws.every(w => w.conf == null)) { out.push(l); continue; }
    const tot = ws.reduce((a, w) => a + len(w), 0), avg = ws.reduce((a, w) => a + cf(w) * len(w), 0) / Math.max(1, tot);
    if (avg < 30 && tot >= 4 && !/[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(l.text)) continue;
    const solid = ws.filter(w => cf(w) >= 70).length;
    if (solid >= 3) {
      let a = 0, b = ws.length;
      const keepW = (w) => /^\d{1,3}[.)]?$/.test(w.text) || /[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(w.text);   // 번호·원어(헬라어·히브리어)는 흐리게 읽혀도 둔다
      while (a < b - 3 && cf(ws[a]) < 20 && !keepW(ws[a])) a++;
      while (b > a + 3 && cf(ws[b - 1]) < 20 && !keepW(ws[b - 1])) b--;
      if (a > 0 || b < ws.length) {
        ws = ws.slice(a, b);
        out.push({ ...l, words: ws, text: ws.map(w => w.text).join(' '), x0: Math.min(...ws.map(w => w.x0)), x1: Math.max(...ws.map(w => w.x1)), y0: Math.min(...ws.map(w => w.y0)), y1: Math.max(...ws.map(w => w.y1)) });
        continue;
      }
    }
    out.push(l);
  }
  return out;
}
// 글씨 색·흰 글씨 띠·상자 색: 색 그림(part.planes)에서 낱말마다 잉크 색을 재고, 뒤집어 읽은 자리(짙은 띠)의 잡티 낱말을 버린다.
//  돌려주는 값: { lines(걸러진 줄), bars(짙은 띠 상자 [{x0,y0,x1,y1,fill}]) }, 상자(part.boxes)의 fill 은 실제 색으로 바꿔 둔다
function colorize(part, lines) {
  const P = part.planes;
  if (!P) return { lines, bars: [] };
  const [R, G, B, MK] = P, W = part.w, H = part.h, g = part.g;
  const hex = (r, gg, b) => [r, gg, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  const med = (a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
  const sample = (x0, y0, x1, y1) => {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
    const st = Math.max(1, Math.round(Math.sqrt((x1 - x0) * (y1 - y0) / 1500)));
    const ink = [[], [], []], dk = [[], [], []], pap = [[], [], []]; let inv = 0, n = 0;
    for (let y = y0; y < y1; y += st) for (let x = x0; x < x1; x += st) {
      const i = y * W + x, v = g[i]; n++; if (MK[i] > 128) inv++;
      const t = v < 70 ? dk : v < 128 ? ink : v > 200 ? pap : null;
      if (t) { t[0].push(R[i]); t[1].push(G[i]); t[2].push(B[i]); }
    }
    const pick = dk[0].length >= 6 ? dk : ink[0].length ? [0, 1, 2].map(c => dk[c].concat(ink[c])) : null;
    return { inv: n ? inv / n : 0, ink: pick ? pick.map(med) : null, paper: pap[0].length >= 4 ? pap.map(med) : null };
  };
  const out = [];
  for (const l of lines) {
    let dropped = false;
    const ws = [];
    for (const w of l.words || []) {
      if (w.x0 == null) { ws.push(w); continue; }
      const sm = sample(w.x0, w.y0, w.x1, w.y1);
      if (sm.inv > 0.5 || part.invAll) {
        // 뒤집어 읽은 자리: 띠가 아니라 손·배경 무늬였으면 뜻 없는 조각이 읽힌다 → 흐리게 읽힌 조각은 버린다
        const t = w.text.replace(/\s/g, ''), wordy = /[가-힣A-Za-z\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]{2}/.test(t) || /^\d{1,3}$/.test(t);
        if (!part.invAll && ((w.conf ?? 100) < (wordy ? 35 : 70))) { dropped = true; continue; }
        // 흰 글씨: 뒤집힌 그림에선 '종이'로 보이는 쪽이 원래 띠 색
        if (sm.paper) { w.bg = hex(...sm.paper); }
        if (sm.ink) { const lum = sm.ink[0] * 0.299 + sm.ink[1] * 0.587 + sm.ink[2] * 0.114; w.color = lum > 150 ? 'FFFFFF' : hex(...sm.ink); } else w.color = 'FFFFFF';
        w.inv = true;
      } else if (sm.ink) {
        const [r, gg, b] = sm.ink, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), lum = r * 0.299 + gg * 0.587 + b * 0.114;
        if (mx - mn >= 60 && mx > 90) {
          // 사진에선 잉크가 종이 색과 섞여 옅게 찍힌다 → 채도를 조금 올려 인쇄 색에 가깝게
          const k = 1.3; w.color = hex(lum + (r - lum) * k - 8, lum + (gg - lum) * k - 8, lum + (b - lum) * k - 8);
        }
      }
      ws.push(w);
    }
    if (!dropped) { out.push(l); continue; }
    if (!ws.length) continue;
    out.push({ ...l, words: ws, text: ws.map(w => w.text).join(' '), x0: Math.min(...ws.map(w => w.x0)), x1: Math.max(...ws.map(w => w.x1)), y0: Math.min(...ws.map(w => w.y0)), y1: Math.max(...ws.map(w => w.y1)) });
  }
  // 비슷한 색은 한 색으로(같은 책의 강조색이 낱말마다 조금씩 다르게 재어진다): 많이 나온 색에 가까운 것을 붙인다
  {
    const cnt = new Map();
    for (const l of out) for (const w of l.words || []) if (w.color && !w.inv) cnt.set(w.color, (cnt.get(w.color) || 0) + [...w.text].length);
    const reps = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]), rgbOf = (h) => [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    const keep = [];
    for (const c of reps) { const v = rgbOf(c); if (!keep.some(k => Math.hypot(...rgbOf(k).map((x, i) => x - v[i])) < 70)) keep.push(c); }
    for (const l of out) for (const w of l.words || []) if (w.color && !w.inv) { const v = rgbOf(w.color); w.color = keep.reduce((best, k) => { const d = Math.hypot(...rgbOf(k).map((x, i) => x - v[i])); return d < best.d ? { c: k, d } : best; }, { c: w.color, d: Infinity }).c; }
  }
  // 상자 색: 상자 안 종이 쪽(글씨 아닌) 점들의 가운데 색
  for (const b of part.boxes || []) {
    const sm = sample(b.x0 + (b.x1 - b.x0) * 0.06, b.y0 + (b.y1 - b.y0) * 0.06, b.x1 - (b.x1 - b.x0) * 0.06, b.y1 - (b.y1 - b.y0) * 0.06);
    if (sm.paper && sm.inv < 0.3) b.fill = hex(...sm.paper);
  }
  // 짙은 띠: 뒤집은 자리 표시에서 반듯한 네모만 골라 그 색으로 칠한 상자로 돌려준다
  const bars = [];
  {
    const c = 8, gw = Math.ceil(W / c), gh = Math.ceil(H / c), m = new Uint8Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) { let n = 0, k = 0; for (let y = gy * c; y < Math.min(H, gy * c + c); y += 2) for (let x = gx * c; x < Math.min(W, gx * c + c); x += 2) { k++; if (MK[y * W + x] > 128) n++; } m[gy * gw + gx] = n > k * 0.5 ? 1 : 0; }
    const lab = new Uint8Array(gw * gh);
    for (let i0 = 0; i0 < m.length; i0++) {
      if (!m[i0] || lab[i0]) continue;
      const st = [i0]; lab[i0] = 1; let x0 = gw, x1 = 0, y0 = gh, y1 = 0, n = 0;
      while (st.length) { const k = st.pop(), x = k % gw, y = (k / gw) | 0; n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; for (const q of [k - 1, k + 1, k - gw, k + gw]) { if (q < 0 || q >= m.length || lab[q] || !m[q]) continue; if ((q === k - 1 && x === 0) || (q === k + 1 && x === gw - 1)) continue; lab[q] = 1; st.push(q); } }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (n < bw * bh * 0.8 || bw * c < W * 0.06 || bh * c > H * 0.3) continue;
      // 그 안에 읽힌 흰 글씨가 있어야 띠로 친다(손·배경은 글이 없다)
      const bx = { x0: x0 * c, y0: y0 * c, x1: (x1 + 1) * c, y1: (y1 + 1) * c };
      const inside = out.flatMap(l => l.words || []).filter(w => w.inv && (w.x0 + w.x1) / 2 > bx.x0 && (w.x0 + w.x1) / 2 < bx.x1 && (w.y0 + w.y1) / 2 > bx.y0 && (w.y0 + w.y1) / 2 < bx.y1);
      if (!inside.length) continue;
      const cols = inside.map(w => w.bg).filter(Boolean);
      if (!cols.length) continue;
      const fill = cols.sort()[cols.length >> 1];
      for (const w of inside) w.bg = fill;
      bars.push({ ...bx, fill, bar: true });
    }
  }
  return { lines: out, bars };
}
export async function readPhotos(files, { decode, ocr, ocrLatin, size, font, keepLines, pageBreaks, onProgress, koScore, markFixes, group = 'auto', encodeImage = null } = {}) {
  const pages = [];
  let n = 0;
  const fixer = koScore ? (await import('./ko-fix.mjs')).makeKoFixer(koScore) : null;
  const fixes = [];
  let fi = -1;
  for (const f of files) {
    fi++;
    const bytes = f.bytes instanceof Uint8Array ? f.bytes : f.arrayBuffer ? new Uint8Array(await f.arrayBuffer()) : new Uint8Array(f.bytes);
    const img = await decode(bytes, f.name);
    for (const part of rectifyPhoto(img)) {
      onProgress?.({ step: 'ocr', page: ++n });
      const png = grayPng(part.g, part.w, part.h);
      let lines = await refineOcr(await ocr(png, part.w, part.h), part, ocr, ocrLatin);
      let bars = [];
      if (!globalThis.process?.env?.NOCOLOR) { try { ({ lines, bars } = colorize(part, lines)); } catch (e) { if (globalThis.__koDbg) console.error('colorize', e); } }
      let pics = [];
      if (!globalThis.process?.env?.NOPICS) { try { ({ lines, pics } = findPictures(part, lines)); } catch (e) { if (globalThis.__koDbg) console.error('pictures', e); } }
      lines = dropJunk(lines);
      // 꾸밈 층(띠·색 상자·그림·읽지 못한 글을 사진 그대로 글 뒤에 깐다) — 되면 따로 찾은 그림·띠·상자 대신 이것을 쓴다
      let layer = null;
      if (!globalThis.process?.env?.NOLAYER) { try { layer = designLayer(part, lines); } catch (e) { layer = null; if (globalThis.__koDbg) console.error('layer', e); } }
      if (layer) {
        const hit = (b) => layer.some(q => { const ox = Math.min(b.x1, q.x1) - Math.max(b.x0, q.x0), oy = Math.min(b.y1, q.y1) - Math.max(b.y0, q.y0); return ox > 0 && oy > 0 && ox * oy > (b.x1 - b.x0) * (b.y1 - b.y0) * 0.4; });
        part.boxes = part.boxes.filter(b => !hit(b)); bars = bars.filter(b => !hit(b));
        pics = layer;
      }
      for (const q of pics) {
        // 그림 파일로: 넘겨받은 인코더(브라우저는 JPEG)가 있으면 그것으로, 없으면 PNG
        let enc = null;
        if (encodeImage) { try { enc = await encodeImage(q.rgb, q.pxW, q.pxH); } catch { enc = null; } }
        if (enc?.data) { q.data = enc.data; q.ext = enc.ext || 'jpg'; q.mime = enc.mime || 'image/jpeg'; }
        else { q.data = encodePng(q.pxW, q.pxH, 2, q.rgb); q.ext = 'png'; q.mime = 'image/png'; }
        delete q.rgb;
      }
      let zones = [];
      if (!globalThis.process?.env?.NOCOLS) { try { ({ lines, zones } = splitColumns(lines, part.w, part.h)); } catch (e) { if (globalThis.__koDbg) console.error('columns', e); } }
      part.planes = null;   // 색 그림은 여기까지만 쓴다(쪽마다 쥐고 있으면 메모리가 모자란다)
      if (globalThis.__koDbg) console.error('BOT', part.h, lines.slice(-3).map(l => [l.text, Math.round(l.y0), Math.round(l.x0), Math.round(l.conf ?? -1)]));
      // 회색 상자 안 글이 아닌 줄(상자 무늬를 글로 잘못 읽은 것)은 버린다
      const mconf = (l) => { const ws = (l.words || []).filter(w => w.conf != null); return ws.length ? ws.reduce((a, w) => a + w.conf, 0) / ws.length : 100; };
      const inBox = (l) => part.boxes.some(b => l.x0 >= b.x0 - 4 && l.x1 <= b.x1 + 4 && l.y0 >= b.y0 - 4 && l.y1 <= b.y1 + 4 && ((!/[가-힣]{2}/.test(l.text.replace(/\s/g, "")) || mconf(l) < 65) && !(l.y0 > part.h * 0.82 && (l.text.match(/[가-힣]/g) || []).length >= 4)));
      let rules = []; try { rules = findRules(part.g, part.w, part.h, lines.filter(l => !inBox(l))); } catch { rules = []; }
      if (globalThis.process?.env?.COLDBG) console.error('ZONES', f.name, part.side, part.w, part.h, JSON.stringify(zones.map(z => Object.values(z).map(Math.round))), lines.filter(l => l.zone != null && l.col === 0).length, lines.filter(l => l.zone != null && l.col === 1).length);
      pages.push({ photo: fi, name: f.name, w: part.w, h: part.h, g: fixer ? part.g : null, lines: lines.filter(l => !inBox(l)), boxes: [...part.boxes, ...bars], zones, pics, rules, pageFound: part.pageFound, spread: part.spread, side: part.side });
    }
  }
  if (fixer) onProgress?.({ step: 'spell' });
  // 사진들이 같은 책인지 가른다: 한 줄 글자 수(판면 폭 ÷ 글자 크기)와 줄 간격(÷ 글자 크기)은 책마다 다르고, 같은 책에선 거의 같다
  const groups = groupPhotos(pages, group);
  const build = (pg) => {
    const fx = [];
    const M = measurePages(pg, { size, font, fixer, fixes: fx });
    for (const p of pg) p.g = null;
    const model = buildBookModel(pg, M, { keepLines: keepLines !== false, pageBreaks: pageBreaks !== false, markFixes: !!markFixes });
    const report = {
      pages: pg.length, photos: new Set(pg.map(p => p.photo)).size, measured: M.report,
      pageFound: pg.every(p => p.pageFound), spread: pg.some(p => p.spread),
      headers: [...new Set(model.notes.headers)], pagenos: model.notes.pagenos,
      ...(fixer ? { fixes: fx } : {}),
    };
    return { ...model, report, measure: M, names: [...new Set(pg.map(p => p.name))] };
  };
  const built = groups.map(build);
  const first = built[0];
  return built.length > 1 ? { ...first, groups: built, report: { ...first.report, groups: built.length } } : first;
}

function groupPhotos(pages, mode) {
  const byPhoto = [];
  for (const p of pages) (byPhoto[p.photo] ||= []).push(p);
  const photos = byPhoto.filter(Boolean);
  if (mode === 'one' || photos.length < 2) return [pages];
  if (mode === 'each') return photos;
  // 사진 하나의 특징값
  const sig = (pg) => {
    const cpl = [], lr = [];
    for (const p of pg) {
      const L = p.lines.filter(l => (l.text.match(/[가-힣]/g) || []).length >= 6).sort((a, b) => a.y0 - b.y0);
      if (L.length < 5) continue;
      const hs = L.map(l => l.y1 - l.y0).sort((a, b) => a - b), em = hs[hs.length >> 1];
      const x0 = L.map(l => l.x0).sort((a, b) => a - b), x1 = L.map(l => l.x1).sort((a, b) => a - b);
      cpl.push((x1[Math.floor(x1.length * 0.85)] - x0[Math.floor(x0.length * 0.15)]) / em);
      const d = []; for (let i = 1; i < L.length; i++) { const v = (L[i].y0 + L[i].y1 - L[i - 1].y0 - L[i - 1].y1) / 2; if (v > em * 0.9 && v < em * 3.5) d.push(v / em); }
      d.sort((a, b) => a - b); if (d.length) lr.push(d[d.length >> 1]);
    }
    const md = (a) => a.length ? a.sort((x, y) => x - y)[a.length >> 1] : null;
    return { cpl: md(cpl), lr: md(lr) };
  };
  const out = [];
  let cur = null, cs = null;
  for (const pg of photos) {
    const s = sig(pg);
    const same = cur && cs && s.cpl && cs.cpl && Math.abs(s.cpl - cs.cpl) / cs.cpl < 0.12 && (!s.lr || !cs.lr || Math.abs(s.lr - cs.lr) / cs.lr < 0.15);
    const unknown = !s.cpl || !cs?.cpl;
    if (cur && (same || unknown)) cur.push(...pg);
    else { cur = [...pg]; out.push(cur); cs = s; }
    if (globalThis.__koDbg) console.error('SIG', pg[0].name, s, same);
  }
  return out;
}
