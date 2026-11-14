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
  const t = otsu(s.g);
  const on = new Uint8Array(s.w * s.h);
  for (let i = 0; i < on.length; i++) on[i] = s.g[i] > t ? 1 : 0;
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
  if (W / H < 1.15) return [{ x0: 0, x1: W }];
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

// ── 사진 한 장 → 펴진 쪽 그림들 ──
export function rectifyPhoto(img) {
  const g = toGray(img.data, img.w, img.h);
  const { quad, found } = findPage(g, img.w, img.h);
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const pw = (len(quad[0], quad[1]) + len(quad[3], quad[2])) / 2;
  const ph = (len(quad[0], quad[3]) + len(quad[1], quad[2])) / 2;
  // 글자 인식이 잘 되도록 한 쪽 가로를 1700~2400 화소로
  const spread = pw / ph > 1.15;
  const scale = Math.min(3, Math.max(1, (spread ? 3400 : 1800) / pw));
  const W = Math.round(pw * scale), H = Math.round(ph * scale);
  const flat = flatten(warp(g, img.w, img.h, quad, W, H), W, H);
  const parts = splitSpread(flat, W, H);
  return parts.map(({ x0, x1 }) => {
    const w = x1 - x0, out = new Uint8Array(w * H);
    for (let y = 0; y < H; y++) out.set(flat.subarray(y * W + x0, y * W + x1), y * w);
    return { g: out, w, h: H, pageFound: found, spread };
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
export function measurePages(pages, opts = {}) {
  // pages: [{ w, h, lines: OCR 줄들 }]
  const font = opts.font || '함초롬바탕';
  const all = [];
  for (const p of pages) {
    p.lines = p.lines.map(l => ({ ...l, text: cleanText(l.text) })).filter(l => l.text && (l.text.replace(/\s/g, '').length >= 2 || /\d/.test(l.text)) && l.y1 > l.y0);
    p.lines.sort((a, b) => a.y0 - b.y0);
    for (const l of p.lines) {
      // 줄 높이·바닥선은 낱말 상자들의 가운값으로 (위아래로 튀는 글자 하나에 휘둘리지 않게)
      const ws = (l.words || []).filter(w => w.y1 > w.y0 && /[가-힣A-Za-z0-9]/.test(w.text));
      const big = ws.filter(w => hangulish(w.text) && w.text.length >= 2);
      const use = big.length >= 2 ? big : ws;
      l.h = use.length ? median(use.map(w => w.y1 - w.y0)) : l.y1 - l.y0;
      l.base = use.length ? median(use.map(w => w.y1)) : l.y1;
    }
  }
  // 본문 줄 높이·줄 사이(같은 크기 줄끼리)
  const hs = pages.flatMap(p => p.lines.map(l => l.h));
  const hMed = median(hs);
  const pitches = [];
  for (const p of pages) for (let i = 1; i < p.lines.length; i++) {
    const a = p.lines[i - 1], b = p.lines[i];
    if (Math.abs(a.h - hMed) < hMed * 0.25 && Math.abs(b.h - hMed) < hMed * 0.25) pitches.push(b.base - a.base);
  }
  const pitch = pct(pitches.filter(v => v > hMed * 0.9), 0.3) || hMed * 1.6;
  // 머리글·쪽 번호: 맨 위·맨 아래 줄이 본문에서 멀리 떨어졌거나 작으면
  for (const p of pages) {
    const L = p.lines;
    if (L.length > 2) {
      const top = L[0], nxt = L[1];
      if (nxt.base - top.base > pitch * 1.45 || top.h < hMed * 0.8) { top.role = /^\s*\d+\s*$/.test(top.text) ? 'pageno' : 'header'; }
      const bot = L.at(-1), prv = L.at(-2);
      if (bot.base - prv.base > pitch * 1.45 || (/^\s*[-–]?\s*\d+\s*[-–]?\s*$/.test(bot.text) && bot.text.length < 8)) bot.role = /\d/.test(bot.text) && bot.text.length < 8 ? 'pageno' : 'footer';
    }
    p.body = L.filter(l => !l.role);
  }
  const body = pages.flatMap(p => p.body);
  if (!body.length) throw Object.assign(new Error('NO_TEXT'), { code: 'NO_TEXT' });
  // 본문 판면(글상자): 왼쪽은 들여쓰지 않은 줄들의 시작, 오른쪽은 꽉 찬 줄들의 끝
  const blockX0 = pct(body.map(l => l.x0), 0.15);
  const blockX1 = pct(body.map(l => l.x1), 0.85);
  // 글자 크기(em, 화소): 한글 줄 높이 / 0.92 (명조·고딕 한글 글자 몸 높이 ≈ 0.92em)
  // 한글 글자 몸 높이 ≈ 0.97em (명조·고딕 평균; 글꼴마다 ±5%)
  const em = median(body.filter(l => hangulish(l.text)).map(l => l.h)) / 0.97 || hMed;
  // 글자 사이를 띄워 양쪽 정렬한 책은 OCR이 음절마다 빈칸을 넣는다 → 낱말 상자 간격으로 빈칸을 다시 정한다
  for (const l of pages.flatMap(p => p.lines)) {
    const ws = (l.words || []).filter(w => w.text.trim()).sort((a, b) => a.x0 - b.x0);
    if (ws.length < 2) continue;
    const gaps = ws.slice(1).map((w, i) => w.x0 - ws[i].x1);
    const g0 = Math.max(0, pct(gaps, 0.2));
    let t = ws[0].text;
    ws.slice(1).forEach((w, i) => { t += (gaps[i] > g0 + em * 0.12 ? ' ' : '') + w.text; });
    l.text = cleanText(t);
  }
  // 판형: 사용자가 고른 것, 아니면 종이 비율로 추정
  const aspect = median(pages.map(p => p.h / p.w));
  let size = BOOK_SIZES[opts.size] || null;
  if (!size) {
    const cands = Object.values(BOOK_SIZES).filter(Boolean);
    size = cands.reduce((b, c) => (Math.abs(c.h / c.w - aspect) < Math.abs(b.h / b.w - aspect) - 0.015 ? c : b), BOOK_SIZES.sinkuk);
    if (Math.abs(size.h / size.w - aspect) > 0.06) size = { w: 152, h: Math.round(152 * aspect), name: `사진 비율(152×${Math.round(152 * aspect)}mm)` };
  }
  const pxPerPt = median(pages.map(p => p.w)) / (size.w * MM);
  const emPt = em / pxPerPt;
  const sizePt = Math.round(emPt * 2) / 2;           // 0.5pt 단위
  const linePct = Math.round((pitch / em) * 100 / 5) * 5;
  // 자간: 꽉 찬 줄의 글자들이 내보낼 글꼴로도 판면 폭을 정확히 채우도록
  const textW = (blockX1 - blockX0) / pxPerPt / sizePt;   // em
  const fulls = body.filter(l => l.x0 < blockX0 + em * 0.4 && l.x1 > blockX1 - em * 0.6 && l.text.length > 8);
  const spacings = fulls.map(l => {
    const chars = [...l.text];
    const sum = chars.reduce((s, c) => s + adv(c, font), 0);
    return (textW - sum) / Math.max(1, chars.length - 1) * 100;
  });
  const spacing = Math.max(-50, Math.min(50, Math.round(median(spacings) || 0)));
  const charsPerLine = Math.round(median(fulls.map(l => [...l.text].length)));
  // 여백(pt)
  const asc = 0.85;   // 줄 맨 위(위 여백)에서 첫 줄 글자 바닥까지 ≈ 0.85em
  const firstBase = median(pages.map(p => p.body[0]?.base).filter(v => v != null));
  const fullPages = pages.filter(p => p.body.length >= 0.8 * Math.max(...pages.map(q => q.body.length)));
  const lastBase = median(fullPages.map(p => p.body.at(-1)?.base).filter(v => v != null));
  const pageH = median(pages.map(p => p.h));
  const lineGap = (linePct / 100 - 1) * em;   // 한글 % 줄 간격의 여분은 줄 아래에 붙는다
  const margin = {
    left: blockX0 / pxPerPt,
    right: (median(pages.map(p => p.w)) - blockX1) / pxPerPt,
    top: Math.max(5 * MM, (firstBase - asc * em) / pxPerPt),
    bottom: 0,
  };
  // 아래 여백: 꽉 찬 쪽의 줄 수가 그대로 들어가도록 (한글은 줄 높이 = 줄 간격만큼 차지)
  const nLines = Math.round(median(fullPages.map(p => p.body.length)));
  const pitchPt = pitch / pxPerPt;
  margin.bottom = Math.max(5 * MM, pageH / pxPerPt - margin.top - nLines * pitchPt - pitchPt * 0.35);
  void lastBase; void lineGap;
  return {
    font, size, pxPerPt, em, emPt, sizePt, linePct, spacing, charsPerLine, blockX0, blockX1, pitch,
    page: { w: size.w * MM, h: size.h * MM, ...margin },
    report: {
      bookSize: size.name, pageMm: [size.w, size.h],
      marginsMm: Object.fromEntries(Object.entries(margin).map(([k, v]) => [k, Math.round(v / MM * 10) / 10])),
      fontPt: sizePt, linePct, spacingPct: spacing, charsPerLine,
      linesPerPage: Math.round(median(fullPages.map(p => p.body.length))),
    },
  };
}

// ── 측정값 + 줄 → 문단 모델 (pdf-convert 모델 형식, 단위 pt) ──
export function buildBookModel(pages, M, opts = {}) {
  const keepLines = !!opts.keepLines;
  const { em, blockX0, blockX1, font, sizePt, linePct, spacing } = M;
  const paras = [];
  const run = (text, extra = {}) => ({ text, font, size: extra.size ?? sizePt, color: '000000', bold: !!extra.bold, italic: false, spacing });
  let cur = null;
  const flush = () => { if (cur) { paras.push(cur); cur = null; } };
  const notes = { headers: [], pagenos: [] };
  pages.forEach((p, pi) => {
    for (const l of p.lines) if (l.role === 'header' || l.role === 'footer') notes.headers.push(l.text); else if (l.role === 'pageno') notes.pagenos.push(l.text.trim());
    p.body.forEach((l, li) => {
      const indent = (l.x0 - blockX0) / em;
      const rightGap = (blockX1 - l.x1) / em;
      const big = l.h > M.em * 0.97 * 1.25;
      const centered = indent > 1.5 && Math.abs(indent - rightGap) < 1.2;
      const prev = li > 0 ? p.body[li - 1] : null;
      const gapAbove = prev ? (l.base - prev.base) - M.pitch : 0;
      const startsNew = !cur || big || centered || cur._ended || indent > 0.45 || gapAbove > M.pitch * 0.4 || cur._big || cur._centered;
      if (startsNew) {
        flush();
        const sz = big ? Math.round(l.h / 0.97 / M.pxPerPt * 2) / 2 : sizePt;
        cur = {
          align: centered ? 'CENTER' : 'JUSTIFY', left: 0, right: 0,
          indent: centered ? 0 : Math.max(0, Math.round(indent * 2) / 2) * sizePt,
          before: Math.max(0, gapAbove / M.pxPerPt), pct: linePct, size: sz,
          runs: [], pageBreak: false, wordBreak: false, _big: big, _centered: centered,
          _pageStart: li === 0 && pi > 0,
        };
        cur.runs.push(run(l.text, { size: sz }));
      } else {
        // 이어지는 줄: 줄 그대로 모드는 줄 바꿈, 아니면 이어 붙이기
        const last = cur.runs.at(-1);
        if (keepLines) cur.runs.push({ br: true }, run(l.text));
        else {
          const prevText = last.text;
          const joiner = /[.,!?:;)」』”’]$/.test(prevText) || !hangulish(prevText.slice(-1)) || !hangulish(l.text[0]) ? ' ' : '';
          last.text = prevText + joiner + l.text;
        }
      }
      cur._ended = rightGap > 1.2 && !centered;
    });
    // 쪽 끝 줄이 꽉 찼으면 다음 쪽 첫 줄로 문단이 이어진다 (cur 유지)
    if (opts.pageBreaks && cur) { flush(); }
  });
  flush();
  // 쪽 나눔을 원본과 맞추고 싶으면 각 쪽 첫 문단 앞에서 나눈다
  if (opts.pageBreaks) for (const p of paras) if (p._pageStart) p.pageBreak = true;
  for (const p of paras) { delete p._big; delete p._centered; delete p._ended; delete p._pageStart; }
  return { paras, page: M.page, notes };
}

// ── 전체: 사진들 → 모델 ──
export async function readPhotos(files, { decode, ocr, size, font, keepLines, pageBreaks, onProgress } = {}) {
  const pages = [];
  let n = 0;
  for (const f of files) {
    const img = await decode(f.bytes, f.name);
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
