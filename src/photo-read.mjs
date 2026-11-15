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
function findPage(g, w, h) {
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
  for (let i = 0; i < on.length; i++) on[i] = s.g[i] > t ? 1 : 0;
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
  // 덩어리의 모서리: x+y 최소(왼쪽 위)·최대(오른쪽 아래), x−y 최대(오른쪽 위)·최소(왼쪽 아래)
  let tl = [0, 0, Infinity], br = [0, 0, -Infinity], tr = [0, 0, -Infinity], bl = [0, 0, Infinity];
  for (let i = 0; i < lab.length; i++) {
    if (!keep.has(lab[i])) continue;
    const x = i % s.w + 0.5, y = ((i / s.w) | 0) + 0.5;
    if (x + y < tl[2]) tl = [x, y, x + y];
    if (x + y > br[2]) br = [x, y, x + y];
    if (x - y > tr[2]) tr = [x, y, x - y];
    if (x - y < bl[2]) bl = [x, y, x - y];
  }
  // 종이 가장자리가 사진 테두리에 닿으면(바짝 찍은 사진) 그 모서리는 사진 모서리로
  const quad = [tl, tr, br, bl].map(([x, y]) => [x * f, y * f]);
  return { quad, found: true };
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
// 조명 고르게: 종이 바탕의 밝기(글자를 지운 밝기 지도)를 구해 나눈다 (그늘·밝기 차이가 있는 사진 대비)
//  - 작은 격자에서 이웃 최댓값(글자 지우기) → 부드럽게 흐리기 → 양선형으로 키워서 나눈다
//    (격자 경계가 계단처럼 남으면 글자 인식이 그 경계를 선으로 읽으므로 반드시 매끄럽게)
// 앞장 글씨만 진하게: 종이 바탕과 글씨를 가르는 문턱(T1) 아래에서 다시 진한 앞장 글씨와 흐린 뒷장 비침을 가른다.
//  가장 진한 글씨(B)는 검정으로, 문턱 근처(W)는 흰색으로 늘려 비친 글씨·얼룩을 지우고 앞장 획을 또렷하게 한다
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
  if (W / H < 0.95) return [{ x0: 0, x1: W }];
  const ink = new Float32Array(W);
  for (let x = 0; x < W; x++) { let n = 0; for (let y = 0; y < H; y += 2) if (g[y * W + x] < 140) n++; ink[x] = n; }
  // 1) 가운데 접힌 곳은 그늘이 진다: 밝기 고르기 전 사진에서 세로줄 평균 밝기가 가장 어두운 골짜기(가운데 근처)
  if (raw) {
    const col = new Float32Array(W);
    for (let x = 0; x < W; x++) { let a = 0, n = 0; for (let y = Math.round(H * 0.1); y < H * 0.9; y += 3) { a += raw[y * W + x]; n++; } col[x] = a / n; }
    const sm = new Float32Array(W), r = Math.max(2, Math.round(W * 0.004));
    for (let x = 0; x < W; x++) { let a = 0, n = 0; for (let k = -r; k <= r; k++) { const q = x + k; if (q >= 0 && q < W) { a += col[q]; n++; } } sm[x] = a / n; }
    let bx = -1, bv = Infinity;
    for (let x = Math.round(W * 0.4); x < W * 0.6; x++) if (sm[x] < bv) { bv = sm[x]; bx = x; }
    const side = (a, b) => { const v = []; for (let x = Math.round(a); x < b; x++) v.push(sm[x]); v.sort((p, q) => p - q); return v[v.length >> 1]; };
    const around = Math.min(side(bx - W * 0.12, bx - W * 0.04), side(bx + W * 0.04, bx + W * 0.12));
    if (globalThis.__koDbg) console.error('GUTTER', bx, Math.round(bv), Math.round(around), ink[bx]);
    if (bx > 0 && around - bv > Math.max(8, around * 0.06) && (ink[bx] <= H * 0.01 || around - bv > 25)) return [{ x0: 0, x1: bx }, { x0: bx, x1: W }];
  }
  let bestX = -1, bestRun = 0;
  for (let x = Math.round(W * 0.35); x < W * 0.65;) {
    if (ink[x] > H * 0.004) { x++; continue; }
    let e = x; while (e < W * 0.65 && ink[e] <= H * 0.004) e++;
    if (e - x > bestRun) { bestRun = e - x; bestX = (x + e) >> 1; }
    x = e + 1;
  }
  if (globalThis.__koDbg) console.error('SPLIT', W, H, bestX, bestRun, Array.from({ length: 30 }, (_, i) => Math.round(ink[Math.round(W * (0.35 + i * 0.01))])).join(','));
  if (bestX < 0) return [{ x0: 0, x1: W }];
  return [{ x0: 0, x1: bestX }, { x0: bestX, x1: W }];
}

// 휜 쪽 펴기: 세로 띠마다 글줄 위치(가로 투영)를 가운데 띠와 맞춰 보아 위아래 어긋남을 재고,
// 위·가운데·아래 세 구역의 어긋남을 이어 붙여 줄이 곧게 되도록 다시 그린다.
function dewarp(g, W, H) {
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
      o[y * W + x] = y0 < 0 || y0 >= H - 1 ? 255 : g[y0 * W + x] * (1 - f) + g[(y0 + 1) * W + x] * f;
    }
  }
  return o;
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
  const { quad, found } = findPage(g, img.w, img.h);
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const pw = (len(quad[0], quad[1]) + len(quad[3], quad[2])) / 2;
  const ph = (len(quad[0], quad[3]) + len(quad[1], quad[2])) / 2;
  // 글자 인식이 잘 되도록 한 쪽 가로를 1700~2400 화소로
  const spread = pw / ph > 0.95;
  const scale = Math.min(3, Math.max(1, (spread ? 3400 : 1800) / pw));
  const W = Math.round(pw * scale), H = Math.round(ph * scale);
  const raw = warp(g, img.w, img.h, quad, W, H);
  const flat0 = flatten(raw, W, H);
  const parts = splitSpread(flat0, W, H, raw);   // 가운데 접힌 그늘은 밝기 조절 전 그림에서 찾는다
  const flat = flat0.even ? flat0 : levels(flat0);   // 앞장 글씨만 진하게(뒷장 비침 지우기)는 사진에만 — 스캔은 이미 고르다
  return parts.map(({ x0, x1 }, pi) => {
    const side = parts.length === 2 ? (pi === 0 ? 'L' : 'R') : null;
    const w = x1 - x0, out = new Uint8Array(w * H), rawPart = new Uint8Array(w * H);
    for (let y = 0; y < H; y++) { out.set(flat.subarray(y * W + x0, y * W + x1), y * w); rawPart.set(raw.subarray(y * W + x0, y * W + x1), y * w); }
    // 휜 종이 펴기: 입체 종이 모형으로 먼저 해 보고, 글줄이 모자라 못 하면 예전 방식(띠 맞추기)
    let sheet = null;
    try { sheet = sheetDewarpMap(out, w, H); } catch { sheet = null; }
    // 거의 평평한 쪽(스캔·평판)은 그대로 두고, 실제로 휜 쪽만 편다
    if (sheet && sheet.rms < 3 && sheet.curvature >= 0.03 && sheet.rmsFlat > Math.max(2.5, sheet.rms * 1.8) && sheet.outW > w * 0.6 && sheet.outW < w * 1.5) {
      const g2 = applyDewarpMap(out, w, H, sheet);
      // 회색 상자: 펴기 전 그림에서 찾고(이 때가 가장 잘 찾아진다), 네 귀·변 가운데를 편 그림 좌표로 옮긴다
      const boxes = findBoxes(rawPart, w, H).map(b => {
        const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1], [(b.x0 + b.x1) / 2, b.y0], [(b.x0 + b.x1) / 2, b.y1], [b.x0, (b.y0 + b.y1) / 2], [b.x1, (b.y0 + b.y1) / 2]].map(([x, y]) => invertPoint(sheet, x, y));
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        // 휜 변은 가운데가 더 안쪽/바깥쪽 → 귀퉁이 기준 사각형
        return { ...b, x0: (pts[0][0] + pts[2][0]) / 2, x1: (pts[1][0] + pts[3][0]) / 2, y0: Math.min(pts[0][1], pts[1][1], pts[4][1]), y1: Math.max(pts[2][1], pts[3][1], pts[5][1]) };
      }).filter(b => b.x1 - b.x0 > 20 && b.y1 - b.y0 > 20);
      return straighten({ even: flat.even, g: g2, w: sheet.outW, h: sheet.outH, pageFound: found, spread, side, boxes, sheet: { rms: sheet.rms, rmsFlat: sheet.rmsFlat, curvature: sheet.curvature, spans: sheet.spans } });
    }
    const g2 = dewarp(out, w, H);
    // 회색 상자는 밝기 고르기 전 그림에서 찾는다 (고르기가 넓은 회색을 흰색으로 지워 버리므로)
    return straighten({ even: flat.even, g: g2, w, h: H, pageFound: found, spread, side, boxes: findBoxes(rawPart, w, H) });
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
  const boxes = part.boxes.map(b => {
    const xa = marginInvX(M, b.x0, b.y0), xb = marginInvX(M, b.x0, b.y1), xc = marginInvX(M, b.x1, b.y0), xd = marginInvX(M, b.x1, b.y1);
    return { ...b, x0: (xa + xb) / 2, x1: (xc + xd) / 2 };
  });
  return { ...part, g, w: W2, boxes, margins: { left: M.Lf.b, right: M.Rf.b } };
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
    p.bx0 = pct(p.body.map(l => l.x0), 0.15);
    p.bx1 = pct(p.body.map(l => l.x1), 0.85);
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
  const sizePt = Math.round(emPt * 2) / 2;
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
  const spacing = Math.max(-50, Math.min(50, Math.round(median(spacings) || 0)));
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
    font, size, emPt, sizePt, linePct, spacing, charsPerLine, pitchPt,
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
  const flush = () => { if (cur) { paras.push(cur); cur = null; } };
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
    const seq = exact ? p.lines.filter(l => !l.role || l.role === 'header' || l.role === 'footer' || l.role === 'pageno') : p.body;
    // 가로 줄은 바로 아래(없으면 위) 글줄에 붙여 두고, 쪽을 다 앉힌 뒤 그 글줄 자리에서 같은 거리만큼 떨어뜨려 긋는다
    const ruleAt = new Map();
    // 회색 상자도 사진의 절대 자리 대신 바로 위 글줄(없으면 아래 글줄)에서 떨어진 거리로 놓는다(글줄을 판면 틀에 맞춰 옮기므로)
    if (exact) for (const bx of p.boxes || []) {
      const above = seq.filter(l => l.y1 <= bx.y0 + p.emPx * 0.3 && !l.role).sort((a, b) => b.y1 - a.y1)[0], below = seq.filter(l => l.y0 >= bx.y0).sort((a, b) => a.y0 - b.y0)[0];
      const anc = above || below; if (!anc) continue;
      const item = { type: 'rect', dy: (bx.y0 - anc.y0) / k, x0: bx.x0 / k + (p.frameShift || 0), w: (bx.x1 - bx.x0) / k, h: (bx.y1 - bx.y0) / k, fill: bx.fill, ratio: bx.round ? 8 : 0 };
      if (!ruleAt.has(anc)) ruleAt.set(anc, []); ruleAt.get(anc).push(item);
    }
    if (exact) for (const r of p.rules || []) {
      const below = seq.filter(l => l.y0 > r.y).sort((a, b) => a.y0 - b.y0)[0], above = seq.filter(l => l.y1 < r.y).sort((a, b) => b.y1 - a.y1)[0];
      const anc = above || below; if (!anc) continue;   // 위 글줄 기준(아래로 떨어진 거리) — 맨 위 선만 아래 글줄 기준
      const full = (r.x1 - r.x0) > (p.bx1 - p.bx0) * 0.45;
      const item = { dy: (r.y - anc.y0) / k, x1: full ? sideM : r.x0 / k + (p.frameShift || 0), x2: full ? sideM + textWfr : r.x1 / k + (p.frameShift || 0), w: Math.max(0.5, r.t / k) };
      if (!ruleAt.has(anc)) ruleAt.set(anc, []); ruleAt.get(anc).push(item);
    }
    seq.forEach((l, li) => {
      // 줄 머리 기준: 휜 종이·원근으로 판면 왼쪽 끝이 위아래로 조금씩 비스듬하므로, 이웃한 본문 줄들의 왼쪽 끝(가운값)을 기준으로 잰다
      const near = p.body.filter(q => Math.abs(q.base - l.base) < p.pitch * 4.5);
      const nb = near.filter(q => [...q.text].length >= (M.charsPerLine || 30) * 0.8);   // 꽉 찬 줄들
      const localX0 = nb.length >= 3 ? pct(nb.map(q => q.x0), 0.3) : near.length >= 3 ? pct(near.map(q => q.x0), 0.2) : p.bx0;
      const indent = (l.x0 - (Math.abs(localX0 - p.bx0) < em * 1.2 ? localX0 : p.bx0)) / em;
      const localX1 = nb.length >= 3 ? pct(nb.map(q => q.x1), 0.7) : p.bx1;
      const rightGap = ((Math.abs(localX1 - p.bx1) < em * 1.5 ? localX1 : p.bx1) - l.x1) / em;
      const big = l.h > em * 0.97 * 1.25 && [...l.text].length < (M.charsPerLine || 40) * 0.75;
      const centered = indent > 1.5 && Math.abs(indent - rightGap) < 1.2;
      // 줄마다 글자 크기: 본문과 12% 넘게 다르면(제목·성경 구절·인용) 그 크기로
      const own = Math.round(l.h / 0.97 / k * 2) / 2;
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
      const before = li === 0 ? (exact ? ((p.topOffset || 0) < lineHpt * 1.5 ? 0 : snap(p.topOffset)) : (p.topOffset || 0))
        : exact && !l.role ? snap(Math.max(0, gapPt)) : Math.max(0, gapPt);
      const pageStart = li === 0 && pi > 0 && opts.pageBreaks !== false;
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
        const widthPt = (!l.role && rightGap < 0.7 && !centered ? textWfr - indPt : (l.x1 - l.x0) / k) * 0.99;
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
        const leftPt = centered ? 0 : Math.max(0, (l.role ? l.x0 / k : p.bx0 / k + snapInd(indent) * em / k) + (p.frameShift || 0) - exLeft);
        // 한 줄이 판 밖으로 넘쳐 다음 줄로 접히지 않게: 들어갈 폭보다 길면 그 줄 글자를 조금 줄인다
        {
          const availPt = (M.page.w - Math.max(3 * MM, exLeft) - Math.max(3 * MM, Math.min(M.page.w - Math.max(3 * MM, exLeft) - textWfr * 1.06, M.page.w * 0.3)) - leftPt) * 0.95;   // 글꼴 너비 어림값 오차만큼 여유
          const wid = runs.reduce((a, r) => a + [...r.text].reduce((b, c) => b + adv(c, font), 0) * r.size + [...r.text].length * (r.spacing ?? 0) / 100 * r.size, 0);
          var fitNeed = wid > 0 ? Math.min(1, availPt / wid) : 1;   // 아래에서 책 전체로 한꺼번에 줄인다(쪽마다 글자 크기가 달라지지 않게)
        }
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
    if (!exact) flush();
  });
  flush();
  for (const p of paras) { delete p._big; delete p._centered; delete p._ended; p.runs = p.runs.flatMap(splitGreek); }
  // 줄 그대로 모드는 사진 한 장마다 쪽을 나누므로, 아래 여백은 넘침 막이로 작게(보이는 자리는 같다)
  const textWall = median(pages.filter(p => p.body.length).map(p => (p.bx1 - p.bx0) / p.pxPerPt));
  const page = exact ? { ...M.page, left: Math.max(3 * MM, exLeft), right: Math.max(3 * MM, Math.min(M.page.w - Math.max(3 * MM, exLeft) - textWall * 1.06, M.page.w * 0.3)), bottom: Math.min(M.page.bottom, 8 * MM) } : M.page;
  if (exact) {
    // 판 폭에 넘치는 줄: 본문 줄은 책 전체에 같은 비율로 줄여 모든 쪽 글자 크기를 같게, 그래도 넘치는 줄만 따로 더
    const needs = paras.filter(q => q._body && q._fit < 1).map(q => q._fit);
    const fb = needs.length >= 2 ? Math.min(...needs.sort((a, b) => a - b).slice(0, Math.max(1, Math.ceil(needs.length * 0.9)))) : 1;
    const shrink = (q, f) => { for (const r of q.runs) r.size = Math.floor(r.size * f * 2) / 2; q.size = Math.max(...q.runs.map(r => r.size)); };
    for (const q of paras) {
      if (q._body && fb < 1) shrink(q, fb);
      const rest = (q._fit ?? 1) / (q._body ? fb : 1);
      if (rest < 1) shrink(q, rest);
    }
    fitPages(paras, page); alignFooters(paras, page);
    // 줄·상자를 붙일 문단에 '문단 위 간격'이 있으면, 한글은 그 문단 기준 자리를 다르게 잡는다(사진 비교로 확인).
    //  그 간격을 같은 높이의 빈 문단으로 바꿔 두고, 글줄 위로 올라가는 줄(제목 위 선)은 그 빈 문단에 붙인다
    for (let i = 0; i < paras.length; i++) {
      const q = paras[i];
      if (!q._rules || !(q.before > 1)) continue;
      const h = Math.round(q.before * 2) / 2;
      const sp = { align: 'LEFT', left: 0, right: 0, indent: 0, before: 0, pct: 100, size: h, runs: [{ ...q.runs[0], text: ' ', size: h }], pageBreak: q.pageBreak, hardBreak: true, wordBreak: false, floats: q.floats };
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
          if (r.type === 'rect') q.floats.push({ type: 'rect', vrel: 'PARA', x0: r.x0, y0: r.dy, w: r.w, h: Math.min(r.h, page.h - (page.top + y + r.dy) - 2), fill: r.fill, ratio: r.ratio, behind: true });
          else q.floats.push({ type: 'line', vrel: 'PARA', x1: r.x1, x2: r.x2, y1: r.dy, y2: r.dy, w: r.w, color: '000000' });
        }
      }
      y += q.size * q.pct / 100;
    }
  }
  for (const p of paras) { delete p._rules; delete p._role; delete p._bottom; delete p._fit; delete p._body; }
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

export async function readPhotos(files, { decode, ocr, ocrLatin, size, font, keepLines, pageBreaks, onProgress, koScore, markFixes, group = 'auto' } = {}) {
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
      const lines = await refineOcr(await ocr(png, part.w, part.h), part, ocr, ocrLatin);
      if (globalThis.__koDbg) console.error('BOT', part.h, lines.slice(-3).map(l => [l.text, Math.round(l.y0), Math.round(l.x0), Math.round(l.conf ?? -1)]));
      // 회색 상자 안 글이 아닌 줄(상자 무늬를 글로 잘못 읽은 것)은 버린다
      const mconf = (l) => { const ws = (l.words || []).filter(w => w.conf != null); return ws.length ? ws.reduce((a, w) => a + w.conf, 0) / ws.length : 100; };
      const inBox = (l) => part.boxes.some(b => l.x0 >= b.x0 - 4 && l.x1 <= b.x1 + 4 && l.y0 >= b.y0 - 4 && l.y1 <= b.y1 + 4 && ((!/[가-힣]{2}/.test(l.text.replace(/\s/g, "")) || mconf(l) < 65) && !(l.y0 > part.h * 0.82 && (l.text.match(/[가-힣]/g) || []).length >= 4)));
      let rules = []; try { rules = findRules(part.g, part.w, part.h, lines.filter(l => !inBox(l))); } catch { rules = []; }
      pages.push({ photo: fi, name: f.name, w: part.w, h: part.h, g: fixer ? part.g : null, lines: lines.filter(l => !inBox(l)), boxes: part.boxes, rules, pageFound: part.pageFound, spread: part.spread, side: part.side });
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
