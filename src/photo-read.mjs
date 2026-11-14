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
  const stack = [];
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
    if (n > bestN) { bestN = n; best = id; }
    id++;
  }
  const frac = bestN / on.length;
  const whole = [[0, 0], [w, 0], [w, h], [0, h]];
  if (frac < 0.2 || frac > 0.97) return { quad: whole, found: false };
  // 덩어리의 모서리: x+y 최소(왼쪽 위)·최대(오른쪽 아래), x−y 최대(오른쪽 위)·최소(왼쪽 아래)
  let tl = [0, 0, Infinity], br = [0, 0, -Infinity], tr = [0, 0, -Infinity], bl = [0, 0, Infinity];
  for (let i = 0; i < lab.length; i++) {
    if (lab[i] !== best) continue;
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
// 조명 고르게: 큰 흐림으로 배경 밝기를 구해 나눈다 (그늘진 사진 대비)
function flatten(g, W, H) {
  const f = Math.max(4, Math.round(W / 60));
  const s = shrink(g, W, H, f);
  // 글자를 지우려고 작은 창에서 최댓값
  const mx = new Float32Array(s.g.length);
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = Math.min(s.w - 1, Math.max(0, x + dx)), Y = Math.min(s.h - 1, Math.max(0, y + dy));
      m = Math.max(m, s.g[Y * s.w + X]);
    }
    mx[y * s.w + x] = m;
  }
  const o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const bx = Math.min(s.w - 1, (x / f) | 0), by = Math.min(s.h - 1, (y / f) | 0);
    const bg = Math.max(60, mx[by * s.w + bx]);
    o[y * W + x] = Math.max(0, Math.min(255, (g[y * W + x] / bg) * 245));
  }
  return o;
}
const grayPng = (g, W, H) => {
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < g.length; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = g[i];
  return encodePng(W, H, 2, rgb);
};

// 펼친 두 쪽(가로로 긴 사진)이면 가운데 글자 없는 골에서 나눈다
function splitSpread(g, W, H) {
  if (W / H < 0.95) return [{ x0: 0, x1: W }];
  const ink = new Float32Array(W);
  for (let x = 0; x < W; x++) { let n = 0; for (let y = 0; y < H; y += 2) if (g[y * W + x] < 140) n++; ink[x] = n; }
  let bestX = -1, bestRun = 0;
  for (let x = Math.round(W * 0.35); x < W * 0.65;) {
    if (ink[x] > H * 0.004) { x++; continue; }
    let e = x; while (e < W * 0.65 && ink[e] <= H * 0.004) e++;
    if (e - x > bestRun) { bestRun = e - x; bestX = (x + e) >> 1; }
    x = e + 1;
  }
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
    if (bh >= h * 0.035 && xs > w * 0.02 && xe < w * 0.98 && y > h * 0.01 && y2 < h * 0.99) {
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
  return boxes;
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
  const flat = flatten(raw, W, H);
  const parts = splitSpread(flat, W, H);
  return parts.map(({ x0, x1 }) => {
    const w = x1 - x0, out = new Uint8Array(w * H), rawPart = new Uint8Array(w * H);
    for (let y = 0; y < H; y++) { out.set(flat.subarray(y * W + x0, y * W + x1), y * w); rawPart.set(raw.subarray(y * W + x0, y * W + x1), y * w); }
    const g2 = dewarp(out, w, H);
    // 회색 상자는 밝기 고르기 전 그림에서 찾는다 (고르기가 넓은 회색을 흰색으로 지워 버리므로)
    return { g: g2, w, h: H, pageFound: found, spread, boxes: findBoxes(rawPart, w, H) };
  });
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
      l.h = use.length ? median(use.map(w => w.y1 - w.y0)) : l.y1 - l.y0;
      l.base = use.length ? median(use.map(w => w.y1)) : l.y1;
    }
    // 글이 아닌 것(손가락·책 모서리를 글로 잘못 읽은 것): 너무 키 큰 줄
    const hm = median(p.lines.map(l => l.h));
    p.lines = p.lines.filter(l => l.h < hm * 2.6 && (l.y1 - l.y0) < hm * 4);
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
      if (nxt.base - top.base > p.pitch * 1.45 || top.h < p.hMed * 0.8) top.role = /^\s*\d+\s*$/.test(top.text) ? 'pageno' : 'header';
      const bot = L.at(-1), prv = L.at(-2);
      if (bot.base - prv.base > p.pitch * 1.45 || (/^\s*[-–]?\s*\d+\s*[-–]?\s*$/.test(bot.text) && bot.text.length < 8)) bot.role = /\d/.test(bot.text) && bot.text.length < 8 ? 'pageno' : 'footer';
      if (bot.role && /\|/.test(bot.text)) bot.role = 'footer';
    }
    p.body = L.filter(l => !l.role);
    p.bx0 = pct(p.body.map(l => l.x0), 0.15);
    p.bx1 = pct(p.body.map(l => l.x1), 0.85);
    p.emPx = median(p.body.filter(l => hangulish(l.text)).map(l => l.h)) / 0.97 || p.hMed;
    // 글자 사이를 띄워 양쪽 정렬한 책은 OCR이 음절마다 빈칸을 넣는다 → 낱말 상자 간격으로 빈칸을 다시 정한다
    for (const l of p.lines) {
      const ws = (l.words || []).filter(w => w.text.trim()).sort((a, b) => a.x0 - b.x0);
      if (ws.length < 2) continue;
      const gaps = ws.slice(1).map((w, i) => w.x0 - ws[i].x1);
      const g0 = Math.max(0, pct(gaps, 0.2));
      let t;
      // 한글은 글자 단위로 쪼개 읽히므로 넓은 틈만 띄어쓰기, 영어·헬라어·숫자 낱말끼리는 늘 띄운다
      const wordy = x => /[A-Za-z0-9\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]$/.test(x);
      const wordyStart = x => /^[("'‘“]?[A-Za-z0-9\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/.test(x);
      const seps = ws.map((w, i) => { if (!i) return ''; const prev = ws[i - 1].text; return gaps[i - 1] > g0 + p.emPx * 0.12 || (wordy(prev) && wordyStart(w.text) && gaps[i - 1] > p.emPx * 0.08) ? ' ' : ''; });
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
    }
  }
  const body = pages.flatMap(p => p.body);
  if (!body.length) throw Object.assign(new Error('NO_TEXT'), { code: 'NO_TEXT' });
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
  const emPt = median(pages.map(p => p.emPx / p.pxPerPt));
  const sizePt = Math.round(emPt * 2) / 2;
  const pitchPt = median(pages.map(p => p.pitch / p.pxPerPt));
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
  const exLeft = Math.min(...pages.filter(p => p.body.length).map(p => pct(p.body.map(l => l.x0), 0.03) / p.pxPerPt));
  const exRight = Math.min(...pages.filter(p => p.body.length).map(p => p.w / p.pxPerPt - pct(p.body.map(l => l.x1), 0.97) / p.pxPerPt));
  const { font, sizePt, linePct, spacing } = M;
  const paras = [];
  const run = (text, size, sp = spacing) => ({ text, font, size: size ?? sizePt, color: '000000', bold: false, italic: false, spacing: sp });
  const notes = { headers: [], pagenos: [] };
  let cur = null;
  const flush = () => { if (cur) { paras.push(cur); cur = null; } };
  pages.forEach((p, pi) => {
    for (const l of p.lines) if (l.role === 'header' || l.role === 'footer') notes.headers.push(l.text); else if (l.role === 'pageno') notes.pagenos.push(l.text.trim());
    const em = p.emPx, pitch = p.pitch, k = p.pxPerPt;
    // 이 쪽의 회색 상자 → 쪽 기준 위치의 도형 (첫 문단에 붙인다)
    const floats = (p.boxes || []).map(bx => ({ type: 'rect', x0: bx.x0 / k, y0: bx.y0 / k, w: (bx.x1 - bx.x0) / k, h: (bx.y1 - bx.y0) / k, fill: bx.fill, ratio: bx.round ? 8 : 0, behind: true }));
    // 쪽마다 줄 간격(사진마다 휨·원근이 달라 쪽마다 조금씩 다르다)
    const pagePct = exact ? Math.max(100, Math.round(pitch / k / sizePt * 100)) : linePct;
    let prevSize = sizePt, prevBase = null;
    p.body.forEach((l, li) => {
      const indent = (l.x0 - p.bx0) / em;
      const rightGap = (p.bx1 - l.x1) / em;
      const big = l.h > em * 0.97 * 1.25 && [...l.text].length < (M.charsPerLine || 40) * 0.75;
      const centered = indent > 1.5 && Math.abs(indent - rightGap) < 1.2;
      // 줄마다 글자 크기: 본문과 12% 넘게 다르면(제목·성경 구절·인용) 그 크기로
      const own = Math.round(l.h / 0.97 / k * 2) / 2;
      const longLine = [...l.text].length >= (M.charsPerLine || 40) * 0.75;   // 꽉 찬 긴 줄은 본문 크기(사진 휨으로 키가 커 보이는 것 막기)
      // 문단 끝 짧은 줄(앞 줄이 꽉 찬 본문 줄, 같은 자리에서 시작)은 본문 크기 그대로
      const prevL = li > 0 ? p.body[li - 1] : null;
      const tail = prevL && [...prevL.text].length >= (M.charsPerLine || 40) * 0.75 && Math.abs(l.x0 - prevL.x0) < em * 0.6 && !centered;
      const size = tail ? sizePt : !longLine && (big || Math.abs(own - sizePt) / sizePt > 0.12) ? own : longLine && own < sizePt * 0.88 ? own : sizePt;
      // 앞 줄과의 거리: 한글은 앞 줄 높이(글자 크기 × 줄 간격)만큼 내려가므로 남는 만큼 문단 앞 간격으로
      const gapPt = prevBase == null ? (pi === 0 ? 0 : p.topOffset || 0) : (l.base - prevBase) / k - (prevSize * pagePct / 100) - 0.85 * (size - prevSize);
      const before = li === 0 ? (p.topOffset || 0) : Math.max(0, gapPt);
      const pageStart = li === 0 && pi > 0 && opts.pageBreaks !== false;
      if (exact) {
        // 줄 하나 = 문단 하나. 꽉 찬 줄은 배분 정렬로 판면 폭을 정확히 채운다 → 줄마다 원본과 같은 글자
        // 줄마다 자간: 이 줄의 글자들이 원본 줄 폭을 정확히 채우도록 (줄 바뀜 없이, 폭도 같게)
        flush();
        const chars = [...l.text];
        const sum = chars.reduce((a, c) => a + adv(c, font), 0);
        const widthPt = (l.x1 - l.x0) / k * 0.99;
        const sp = chars.length > 1 ? Math.max(-50, Math.min(50, Math.floor((widthPt / size - sum) / (chars.length - 1) * 100))) : spacing;
        cur = {
          align: centered ? 'CENTER' : 'LEFT',
          left: centered ? 0 : Math.max(0, l.x0 / k - exLeft), right: 0, indent: 0,
          before, pct: pagePct, size, runs: [run(l.text, size, sp)], pageBreak: pageStart, hardBreak: true, wordBreak: false,
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
  const page = exact ? { ...M.page, left: Math.max(3 * MM, exLeft), right: 3 * MM, bottom: Math.min(M.page.bottom, 8 * MM) } : M.page;
  if (exact) fitPages(paras, page);
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

// ── 전체: 사진들 → 모델 ──
export async function readPhotos(files, { decode, ocr, size, font, keepLines, pageBreaks, onProgress } = {}) {
  const pages = [];
  let n = 0;
  for (const f of files) {
    const bytes = f.bytes instanceof Uint8Array ? f.bytes : f.arrayBuffer ? new Uint8Array(await f.arrayBuffer()) : new Uint8Array(f.bytes);
    const img = await decode(bytes, f.name);
    for (const part of rectifyPhoto(img)) {
      onProgress?.({ step: 'ocr', page: ++n });
      const png = grayPng(part.g, part.w, part.h);
      const lines = await ocr(png, part.w, part.h);
      // 회색 상자 안 글이 아닌 줄(상자 무늬를 글로 잘못 읽은 것)은 버린다
      const inBox = (l) => part.boxes.some(b => l.x0 >= b.x0 - 4 && l.x1 <= b.x1 + 4 && l.y0 >= b.y0 - 4 && l.y1 <= b.y1 + 4 && !/[가-힣]{2}/.test(l.text));
      pages.push({ w: part.w, h: part.h, lines: lines.filter(l => !inBox(l)), boxes: part.boxes, pageFound: part.pageFound, spread: part.spread });
    }
  }
  const M = measurePages(pages, { size, font });
  const model = buildBookModel(pages, M, { keepLines: keepLines !== false, pageBreaks: pageBreaks !== false });
  const report = {
    pages: pages.length, measured: M.report,
    pageFound: pages.every(p => p.pageFound), spread: pages.some(p => p.spread),
    headers: [...new Set(model.notes.headers)], pagenos: model.notes.pagenos,
  };
  return { ...model, report, measure: M };
}
