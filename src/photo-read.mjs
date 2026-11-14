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
  const flat = flatten(warp(g, img.w, img.h, quad, W, H), W, H);
  const parts = splitSpread(flat, W, H);
  return parts.map(({ x0, x1 }) => {
    const w = x1 - x0, out = new Uint8Array(w * H);
    for (let y = 0; y < H; y++) out.set(flat.subarray(y * W + x0, y * W + x1), y * w);
    return { g: dewarp(out, w, H), w, h: H, pageFound: found, spread };
  });
}

// ── 글자 폭 (내보낼 글꼴 기준, em 단위) ──
function adv(ch, font) {
  if (ch === ' ') return HWP_SPACE;
  const c = ch.codePointAt(0);
  if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f) || (c >= 0x4e00 && c <= 0x9fff)) return HANGUL_ADVANCE[font] ?? 1;
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
      let t = ws[0].text;
      ws.slice(1).forEach((w, i) => { t += (gaps[i] > g0 + p.emPx * 0.12 ? ' ' : '') + w.text; });
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
  const top = Math.max(5 * MM, median(pages.filter(p => p.body.length).map(p => (p.body[0].base - asc * p.emPx) / p.pxPerPt)));
  const bottom = Math.max(5 * MM, size.h * MM - top - nLines * pitchPt - pitchPt * 0.35);
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
  const keepLines = !!opts.keepLines;
  const { font, sizePt, linePct, spacing } = M;
  const paras = [];
  const run = (text, extra = {}) => ({ text, font, size: extra.size ?? sizePt, color: '000000', bold: !!extra.bold, italic: false, spacing });
  let cur = null;
  const flush = () => { if (cur) { paras.push(cur); cur = null; } };
  const notes = { headers: [], pagenos: [] };
  pages.forEach((p, pi) => {
    for (const l of p.lines) if (l.role === 'header' || l.role === 'footer') notes.headers.push(l.text); else if (l.role === 'pageno') notes.pagenos.push(l.text.trim());
    const em = p.emPx, pitch = p.pitch;
    p.body.forEach((l, li) => {
      const indent = (l.x0 - p.bx0) / em;
      const rightGap = (p.bx1 - l.x1) / em;
      const big = l.h > em * 0.97 * 1.25 && [...l.text].length < (M.charsPerLine || 40) * 0.75;   // 제목은 크고 짧다
      const centered = indent > 1.5 && Math.abs(indent - rightGap) < 1.2;
      const prev = li > 0 ? p.body[li - 1] : null;
      const gapAbove = prev ? (l.base - prev.base) - pitch : 0;
      const startsNew = !cur || big || centered || cur._ended || indent > 0.45 || gapAbove > pitch * 0.4 || cur._big || cur._centered || (li === 0 && opts.pageBreaks);
      if (startsNew) {
        flush();
        const sz = big ? Math.round(l.h / 0.97 / p.pxPerPt * 2) / 2 : sizePt;
        cur = {
          align: centered ? 'CENTER' : 'JUSTIFY', left: Math.max(0, indent > 3 && rightGap < 1 && !centered ? 0 : 0), right: 0,
          indent: centered ? 0 : Math.max(0, Math.min(6, Math.round(indent * 2) / 2)) * sizePt,
          before: Math.max(0, gapAbove / p.pxPerPt), pct: linePct, size: sz,
          runs: [], pageBreak: !!(opts.pageBreaks && li === 0 && pi > 0), wordBreak: false, _big: big, _centered: centered,
        };
        cur.runs.push(run(l.text, { size: sz }));
      } else {
        const last = cur.runs.at(-1);
        if (keepLines) cur.runs.push({ br: true }, run(l.text));
        else {
          const prevText = last.text;
          // 줄 끝 글자가 조사·어미로 흔히 끝나는 글자면 낱말이 끝난 것으로 보고 띄운다 (글자 단위로 끊는 책 대비)
          const endsWord = /[다고며서는은을를의에로만과와도게면니데께듯요]$/.test(prevText);
          const joiner = /[.,!?:;)」』”’]$/.test(prevText) || !hangulish(prevText.slice(-1)) || !hangulish(l.text[0]) || endsWord ? ' ' : '';
          last.text = prevText + joiner + l.text;
        }
      }
      cur._ended = rightGap > 1.2 && !centered;
    });
  });
  flush();
  for (const p of paras) { delete p._big; delete p._centered; delete p._ended; }
  return { paras, page: M.page, notes };
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
      pages.push({ w: part.w, h: part.h, lines, pageFound: part.pageFound, spread: part.spread });
    }
  }
  const M = measurePages(pages, { size, font });
  const model = buildBookModel(pages, M, { keepLines, pageBreaks });
  const report = {
    pages: pages.length, measured: M.report,
    pageFound: pages.every(p => p.pageFound), spread: pages.some(p => p.spread),
    headers: [...new Set(model.notes.headers)], pagenos: model.notes.pagenos,
  };
  return { ...model, report, measure: M };
}
