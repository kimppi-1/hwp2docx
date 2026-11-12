// PDF → 문단 모델 (글자 위치·크기·색·굵기를 읽어 문단과 쪽 설정을 되살린다)
// pdf.js(pdfjs-dist)는 밖에서 넘겨받는다: readPdf(bytes, pdfjs)
import { zlibSync } from 'fflate';
import { extractGraphics, detectTables, buildGrid } from './pdf-tables.mjs';
// 단위: pt. 결과의 쪽 설정·여백·간격도 pt.

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(buf, start = 0, end = buf.length) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export function encodePng(w, h, kind, data, fillHex = null) {
  if (!w || !h || !data) return null;
  const colorType = (kind === 3 || (kind === 1 && fillHex)) ? 6 : 2;
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp + 1;
  const raw = new Uint8Array(h * stride);
  if (kind === 2 && data.length >= w * h * 3) {
    for (let y = 0; y < h; y++) raw.set(data.subarray(y * w * 3, (y + 1) * w * 3), y * stride + 1);
  } else if (kind === 3 && data.length >= w * h * 4) {
    for (let y = 0; y < h; y++) raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1);
  } else if (kind === 1) {
    const rowBytes = (w + 7) >> 3;
    const fr = fillHex ? parseInt(fillHex.slice(0, 2), 16) : 0;
    const fg = fillHex ? parseInt(fillHex.slice(2, 4), 16) : 0;
    const fb = fillHex ? parseInt(fillHex.slice(4, 6), 16) : 0;
    for (let y = 0; y < h; y++) {
      let dst = y * stride + 1;
      for (let x = 0; x < w; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        if (fillHex) {
          const on = bit === 0;
          raw[dst++] = fr; raw[dst++] = fg; raw[dst++] = fb; raw[dst++] = on ? 255 : 0;
        } else {
          const v = bit ? 255 : 0;
          raw[dst++] = v; raw[dst++] = v; raw[dst++] = v;
        }
      }
    }
  } else return null;
  const idat = zlibSync(raw, { level: 6 });
  const out = new Uint8Array(8 + 25 + (12 + idat.length) + 12);
  const dv = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let p = 8;
  const chunk = (type, body) => {
    dv.setUint32(p, body.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(body, p + 8);
    dv.setUint32(p + 8 + body.length, crc32(out, p + 4, p + 8 + body.length));
    p += 12 + body.length;
  };
  const ihdr = new Uint8Array(13), idv = new DataView(ihdr.buffer);
  idv.setUint32(0, w); idv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = colorType;
  chunk('IHDR', ihdr); chunk('IDAT', idat); chunk('IEND', new Uint8Array(0));
  return out;
}
function objToPng(obj, fillHex = null) {
  if (!obj || !obj.width || !obj.height) return null;
  let { width: w, height: h, kind, data, bitmap } = obj;
  if (!data && bitmap && typeof document !== 'undefined') {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    data = ctx.getImageData(0, 0, w, h).data; kind = 3;
  }
  return encodePng(w, h, kind ?? 1, data, fillHex);
}

const FONT_KO = [
  [/HCR\s*Batang|HCRBatang|HamchoromBatang/i, '함초롬바탕'], [/HCR\s*Dotum|HCRDotum|HamchoromDotum/i, '함초롬돋움'],
  [/Malgun\s*Gothic|MalgunGothic/i, '맑은 고딕'], [/NanumSquare/i, '나눔스퀘어'], [/NanumBarunGothic/i, '나눔바른고딕'],
  [/NanumGothic/i, '나눔고딕'], [/NanumMyeongjo/i, '나눔명조'], [/Gulim/i, '굴림'], [/Dotum/i, '돋움'], [/Batang/i, '바탕'],
  [/Gungsuh/i, '궁서'], [/Times\s*New\s*Roman|TimesNewRoman/i, 'Times New Roman'], [/Arial/i, 'Arial'], [/Calibri/i, 'Calibri'],
  [/Cambria/i, 'Cambria'], [/Pretendard/i, 'Pretendard'], [/NotoSansKR|Noto\s*Sans\s*KR|NotoSansCJK/i, 'Noto Sans KR'],
  [/NotoSerifKR|Noto\s*Serif\s*KR|NotoSerifCJK/i, 'Noto Serif KR'],
];
function fontInfo(raw) {
  const name = String(raw || '').replace(/^[A-Z]{6}\+/, '');
  const bold = /bold|black|heavy|-B$|ExtraBold|SemiBold/i.test(name);
  const italic = /italic|oblique/i.test(name);
  for (const [re, ko] of FONT_KO) if (re.test(name)) return { name: ko, bold, italic };
  const base = name.replace(/[-,](Bold|Italic|Regular|Black|Heavy|Medium|Light|BoldItalic|Roman|MT|PS|PSMT)+$/i, '').replace(/(PSMT|MT)$/, '');
  return { name: base || '함초롬바탕', bold, italic };
}
const hex = (c) => c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const isWs = (c) => /\s/.test(c);
const snapSize = (s) => Math.round(s * 2) / 2;

// ── 1. 쪽마다 글자 줄 읽기 ──
async function readPage(page, pdfjs) {
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height, vpT = vp.transform;
  const ops = await page.getOperatorList();
  const tc = await page.getTextContent();
  const O = pdfjs.OPS;
  // 연산 목록을 따라가며 글자마다 색·굵기를 기록 (textContent에는 색이 없다)
  const stream = [], imgOps = [];
  let fill = '000000', mode = 0, fontId = null, images = 0, lines = 0, ctm = [1, 0, 0, 1, 0, 0];
  const stack = [], spaceW = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], a = ops.argsArray[i];
    if (fn === O.save) stack.push([fill, mode, ctm]);
    else if (fn === O.restore) { const s = stack.pop(); if (s) [fill, mode, ctm] = s; }
    else if (fn === O.transform) ctm = mul(ctm, a);
    else if (fn === O.setFillRGBColor) fill = hex([a[0], a[1], a[2]]);
    else if (fn === O.setFillGray) fill = hex([a[0] * 255, a[0] * 255, a[0] * 255]);
    else if (fn === O.setTextRenderingMode) mode = a[0];
    else if (fn === O.setFont) fontId = a[0];
    else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) {
      images++;
      const M = mul(vpT, ctm);
      const p0 = apply(M, 0, 0), p1 = apply(M, 1, 0), p2 = apply(M, 1, 1), p3 = apply(M, 0, 1);
      const x0 = Math.min(p0[0], p1[0], p2[0], p3[0]), x1 = Math.max(p0[0], p1[0], p2[0], p3[0]);
      const y0 = Math.min(p0[1], p1[1], p2[1], p3[1]), y1 = Math.max(p0[1], p1[1], p2[1], p3[1]);
      if (x1 - x0 >= 2 && y1 - y0 >= 2) imgOps.push({ fn, arg: a[0], x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, fill });
    }
    else if (fn === O.constructPath) lines++;
    else if (fn === O.showText || fn === O.showSpacedText) {
      for (const g of a[0] || []) {
        if (!g || typeof g === 'number') continue;
        const u = g.unicode || '';
        for (const ch of u) {
          if (isWs(ch)) { if (stream.length) stream.at(-1).spaceAfter = true; if (ch === ' ' && g.width > 0) spaceW.push([fontId, g.width / 1000]); }   // 줄 끝 빈칸은 화면에 안 보여도 연산에는 남아 있다
          else stream.push({ ch, color: fill, fake: mode === 2, fontId });
        }
      }
    }
  }
  const pageImages = [], pngCache = new Map();
  for (const op of imgOps) {
    try {
      let obj = null, key = null;
      if (op.fn === O.paintImageXObject && typeof op.arg === 'string') {
        key = op.arg;
        const pool = key.startsWith('g_') ? page.commonObjs : page.objs;
        obj = await Promise.race([new Promise(r => pool.get(key, r)), new Promise(r => setTimeout(() => r(null), 1500))]);
      } else if (op.arg && typeof op.arg === 'object') obj = op.arg;
      if (!obj || !obj.width || !obj.height) continue;
      if (op.fn === O.paintImageMaskXObject && obj.width < 8 && obj.height < 8) continue;
      let png = key && pngCache.has(key) ? pngCache.get(key) : null;
      if (!png) {
        png = objToPng(obj, op.fn === O.paintImageMaskXObject ? op.fill : null);
        if (key && png) pngCache.set(key, png);
      }
      if (png) pageImages.push({ x0: op.x0, y0: op.y0, x1: op.x1, y1: op.y1, w: op.w, h: op.h, pxW: obj.width, pxH: obj.height, data: png, ext: 'png', mime: 'image/png' });
    } catch {}
  }
  const fontName = (id) => { try { return page.commonObjs.get(id)?.name; } catch { return null; } };
  // textContent 글자에 색 맞추기 (공백 뺀 글자 순서로 맞춰 간다)
  let ptr = 0, last = { color: '000000', fake: false };
  const styleFor = (c) => {
    if (stream[ptr]?.ch === c) { last = stream[ptr++]; return last; }
    for (let k = 1; k < 30 && ptr + k < stream.length; k++) if (stream[ptr + k].ch === c) { ptr += k; last = stream[ptr++]; return last; }
    return last;
  };
  const items = [];
  for (const it of tc.items) {
    if (it.str == null) continue;
    const t = it.transform;
    if (Math.abs(t[1]) > 0.01 * Math.hypot(t[0], t[1])) continue;   // 돌아간 글자는 뺀다
    const size = Math.abs(t[3]) || Math.hypot(t[0], t[1]);
    const slant = Math.abs(t[2]) > 0.05 * size;                     // 기울인 글자 (워드의 '기울임'은 글꼴을 비스듬히 눕혀 그린다)
    const fi = fontInfo(fontName(it.fontName));
    const chars = [];
    for (const c of it.str) {
      if (isWs(c)) { chars.push({ c: ' ', ws: true }); continue; }
      const s = styleFor(c);
      const white = /^(F[A-F0-9]){3}$/.test(s.color) && s.color !== 'FF0000';
      chars.push({ c, color: s.color, white, bold: fi.bold || s.fake, italic: fi.italic || slant, font: fi.name, size: snapSize(size), rawSize: size, spaceAfter: !!s.spaceAfter });
    }
    if (!chars.length) continue;
    const onlyWs = chars.every(x => x.ws);
    const [px, py] = [vpT[0] * t[4] + vpT[2] * t[5] + vpT[4], vpT[1] * t[4] + vpT[3] * t[5] + vpT[5]];
    items.push({ x: px, y: py, w: onlyWs ? 0 : it.width, size, chars, onlyWs });
  }
  // 같은 기준선끼리 묶어 줄을 만든다
  items.sort((p, q) => p.y - q.y || p.x - q.x);
  const rows = [];
  for (const it of items) {
    const r = rows.find(r => Math.abs(r.y - it.y) < 0.35 * Math.max(r.size, it.size));
    if (r) { r.items.push(it); if (!it.onlyWs) r.size = Math.max(r.size, it.size); } else rows.push({ y: it.y, size: it.onlyWs ? 0 : it.size, items: [it] });
  }
  const outLines = [];
  for (const r of rows) {
    const its = r.items.sort((p, q) => p.x - q.x);
    const solid = its.filter(i => !i.onlyWs);
    if (!solid.length) continue;
    const chars = [], gaps = [];
    let prevEnd = null;
    for (const it of its) {
      if (it.onlyWs) { if (chars.length && !chars.at(-1).ws) chars.push({ c: ' ', ws: true, x: it.x }); continue; }
      if (prevEnd != null && chars.length && (chars.at(-1).ws || chars.at(-1).spaceAfter || it.x - prevEnd > 0.18 * it.size)) gaps.push(it.x - prevEnd);   // 낱말 사이 간격 (양쪽 정렬로 늘어났는지 볼 때 씀)
      if (prevEnd != null && chars.length && !chars.at(-1).ws && (chars.at(-1).spaceAfter || it.x - prevEnd > 0.18 * it.size)) chars.push({ c: ' ', ws: true });
      const n = it.chars.length;
      it.chars.forEach((ch, k) => chars.push({ ...ch, x: it.x + it.w * k / n, w: it.w / n }));
      prevEnd = it.x + it.w;
    }
    let trailingSpace = false;
    while (chars.length && chars.at(-1).ws) { chars.pop(); trailingSpace = true; }
    if (chars.at(-1)?.spaceAfter) trailingSpace = true;
    while (chars.length && chars[0].ws) chars.shift();
    // 빈칸에도 자리를 준다 (앞 글자 끝)
    for (let k = 0; k < chars.length; k++) if (chars[k].ws && chars[k].x == null) { const p = chars[k - 1]; chars[k].x = p ? p.x + (p.w || 0) : 0; chars[k].w = 0; }
    // 공백은 앞 글자 모양을 따른다
    let st = chars.find(c => !c.ws);
    for (const ch of chars) { if (ch.ws) Object.assign(ch, { color: st.color, white: st.white, bold: st.bold, italic: st.italic, font: st.font, size: st.size }); else st = ch; }
    const sizes = new Map(); for (const c of chars) if (!c.ws) sizes.set(c.size, (sizes.get(c.size) || 0) + 1);
    const size = [...sizes].sort((a, b) => b[1] - a[1])[0][0];
    const x0 = solid[0].x, x1 = Math.max(...solid.map(i => i.x + i.w));
    const sp = chars.findIndex(c => c.ws);
    const firstWordW = sp > 0 && chars[sp].x != null ? chars[sp].x - x0 : x1 - x0;
    outLines.push({ y: r.y, x0, x1, size, chars, firstWordW, trailingSpace, gapSum: gaps.reduce((a, b) => a + b, 0), gapN: gaps.length, avgGap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null });
  }
  const spaces = spaceW.map(([id, w]) => [fontInfo(fontName(id)).name, w]);
  return { W, H, lines: outLines, images, pageImages, paths: lines, spaces, graphics: extractGraphics(ops, O, vpT) };
}

// ── 2. 줄 → 문단 ──
const mode = (vals, step = 0.5) => {
  const m = new Map(); for (const v of vals) { const k = Math.round(v / step) * step; m.set(k, (m.get(k) || 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
};
function toRuns(chars) {
  const runs = [];
  for (const c of chars) {
    const l = runs.at(-1);
    if (l && l.color === c.color && l.bold === c.bold && l.italic === c.italic && l.font === c.font && l.size === c.size) l.text += c.c;
    else runs.push({ text: c.c, color: c.color, bold: !!c.bold, italic: !!c.italic, font: c.font, size: c.size });
  }
  return runs;
}

// 글자 목록 → 줄 (표 칸으로 나눈 조각에 씀)
function makeLine(chs, base) {
  const chars = chs.slice();
  while (chars.length && chars.at(-1).ws) chars.pop();
  while (chars.length && chars[0].ws) chars.shift();
  if (!chars.some(c => !c.ws)) return null;
  const solid = chars.filter(c => !c.ws);
  const x0 = solid[0].x, x1 = Math.max(...solid.map(c => c.x + (c.w || 0)));
  const sizes = new Map(); for (const c of solid) sizes.set(c.size, (sizes.get(c.size) || 0) + 1);
  const size = [...sizes].sort((a, b) => b[1] - a[1])[0][0];
  const sp = chars.findIndex(c => c.ws);
  const firstWordW = sp > 0 ? chars[sp].x - x0 : x1 - x0;
  const lastSolid = solid.at(-1);
  const trailingSpace = chs.at(-1) === lastSolid ? !!lastSolid.spaceAfter || (lastSolid === base.chars.at(-1) && base.trailingSpace) : true;
  return { y: base.y, x0, x1, size, chars, firstWordW, trailingSpace, gapSum: 0, gapN: 0, avgGap: null };
}

export async function readPdf(bytes, pdfjs, opts = {}) {
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false, isEvalSupported: false, verbosity: 0, cMapUrl: opts.cMapUrl, cMapPacked: true, standardFontDataUrl: opts.standardFontDataUrl }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') { const x = new Error('PASSWORD'); x.code = 'PASSWORD'; throw x; }
    throw e;
  }
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) pages.push(await readPage(await doc.getPage(p), pdfjs));
  // 빈칸 폭: 한글이 만든 PDF는 한글 빈칸(글자 크기의 절반) 그대로. 다른 프로그램(워드 등)은 글꼴의 빈칸 글자 폭을 따른다.
  let producer = '';
  try { const md = await doc.getMetadata(); producer = `${md?.info?.Producer || ''} ${md?.info?.Creator || ''}`; } catch {}
  const hancom = /hancom|hwp|한컴|한글/i.test(producer);
  await doc.destroy?.();
  const everyLine = pages.flatMap(pg => pg.lines);
  const report = { pages: pages.length, images: pages.reduce((a, p) => a + p.images, 0), drawings: pages.reduce((a, p) => a + p.paths, 0), tables: 0, whiteText: 0, fonts: [...new Set(everyLine.flatMap(l => l.chars.filter(c => !c.ws).map(c => c.font)))] };
  if (!everyLine.length) { const e = new Error('NO_TEXT'); e.code = 'NO_TEXT'; throw e; }

  // 표 찾기: 표 선·칸 배경으로 칸을 나누고, 표 안 글자를 칸으로 옮긴다
  if (opts.tables !== false) for (const pg of pages) {
    pg.tables = [];
    for (const t of detectTables(pg.graphics)) {
      const inside = pg.lines.filter(l => l.y > t.y0 + 0.5 && l.y < t.y1 + 0.5 && l.x1 > t.x0 + 0.5 && l.x0 < t.x1 - 0.5);
      const insideImgs = (pg.pageImages || []).filter(im => im.x0 >= t.x0 - 2 && im.x1 <= t.x1 + 2 && im.y0 >= t.y0 - 2 && im.y1 <= t.y1 + 2);
      if (!inside.length && !insideImgs.length) continue;             // 글·그림이 없는 장식 상자
      const grid = buildGrid(t);
      if (grid.cells.length === 1 && pg.lines.length > 8 && inside.length > pg.lines.length * 0.6) continue;   // 쪽 전체를 두른 테두리
      for (const c of grid.cells) { c.lines = []; c.images = []; }
      for (const im of insideImgs) {
        const cx = (im.x0 + im.x1) / 2, cy = (im.y0 + im.y1) / 2;
        const cell = grid.cells.find(c => cx >= c.x0 - 1 && cx <= c.x1 + 1 && cy >= c.y0 - 1 && cy <= c.y1 + 1);
        if (cell) { cell.images.push(im); pg.pageImages = pg.pageImages.filter(x => x !== im); }
      }
      const rest = [];
      for (const l of inside) {
        const byCell = new Map(), outside = [];
        for (const ch of l.chars) {
          const cx = ch.x + (ch.w || 0) / 2;
          const cell = grid.cells.find(c => cx >= c.x0 - 0.5 && cx <= c.x1 + 0.5 && l.y >= c.y0 - 0.5 && l.y <= c.y1 + 0.5);
          if (cell) { if (!byCell.has(cell)) byCell.set(cell, []); byCell.get(cell).push(ch); } else outside.push(ch);
        }
        for (const [cell, chs] of byCell) { const nl = makeLine(chs, l); if (nl) cell.lines.push(nl); }
        const ol = makeLine(outside, l); if (ol) rest.push(ol);
      }
      t.grid = grid;
      pg.lines = pg.lines.filter(l => !inside.includes(l)).concat(rest).sort((a, b) => a.y - b.y || a.x0 - b.x0);
      pg.tables.push(t);
      report.tables++;
    }
  } else for (const pg of pages) pg.tables = [];
  for (const pg of pages) {
    pg.blockImages = []; pg.floatImages = [];
    const rem = pg.pageImages || [];
    for (const im of rem) {
      const ovLine = pg.lines.some(l => l.y - 0.85 * l.size < im.y1 - 1 && l.y + 0.15 * l.size > im.y0 + 1);
      const ovTbl = pg.tables.some(t => t.y0 < im.y1 - 1 && t.y1 > im.y0 + 1);
      const ovImg = rem.some(o => o !== im && o.y0 < im.y1 - 2 && o.y1 > im.y0 + 2);
      if (!ovLine && !ovTbl && !ovImg) pg.blockImages.push(im);
      else pg.floatImages.push({ ...im, behind: pg.lines.some(l => l.x1 > im.x0 && l.x0 < im.x1 && l.y > im.y0 && l.y < im.y1) });
    }
  }
  // 표 칸 안 줄 간격 (워드는 칸 안을 본문과 다른 줄 간격으로 두는 일이 많다): 칸 안 이웃 줄 간격 / 글자 크기 의 최빈값
  const cellRatios = [];
  for (const pg of pages) for (const t of pg.tables) for (const c of t.grid.cells) {
    const ls = [...c.lines].sort((a, b) => a.y - b.y);
    for (let k = 1; k < ls.length; k++) { const a = ls[k - 1], b = ls[k]; const g = b.y - a.y; if (Math.abs(a.size - b.size) < 0.6 && g > 0.9 * a.size && g < 2.6 * a.size) cellRatios.push(g / (a.chars.find(c => !c.ws)?.rawSize ?? a.size)); }
  }
  const cellR = cellRatios.length ? mode(cellRatios, 0.02) : null;
  const bodyLines = pages.flatMap(pg => pg.lines);
  const all = bodyLines.length ? bodyLines : pages.flatMap(pg => pg.tables.flatMap(t => t.grid.cells.flatMap(c => c.lines)));

  // 종이 크기: 표준 크기와 1pt 안쪽이면 그 값으로 (PDF는 A4를 595×841처럼 반올림해 적기도 한다)
  const PAPER = [[595.28, 841.89], [612, 792], [515.91, 728.5], [498.9, 708.66], [841.89, 1190.55], [419.53, 595.28]];
  const snapPaper = (w, h) => { for (const [a, b] of PAPER) { if (Math.abs(w - a) < 1.2 && Math.abs(h - b) < 1.2) return [a, b]; if (Math.abs(w - b) < 1.2 && Math.abs(h - a) < 1.2) return [b, a]; } return [w, h]; };
  const [W, H] = snapPaper(pages[0].W, pages[0].H);
  const S = mode(all.flatMap(l => Array(Math.max(1, l.chars.length)).fill(l.size)));
  const L = mode(all.map(l => l.x0));
  // 오른쪽 끝: 꽉 찬 줄들의 끝 (오른쪽으로 가장 많이 몰린 값)
  const ends = all.map(l => l.x1).sort((a, b) => a - b);
  const p95 = ends[Math.min(ends.length - 1, Math.floor(ends.length * 0.95))];
  // 오른쪽 끝에 몰린 값이 있으면 그것(양쪽 정렬), 없으면 95% 지점
  const flushR = mode(ends.filter(e => e > p95 - 3), 0.5);
  // 오른쪽이 들쭉날쭉한 문서(글자 단위로 줄을 바꾼 왼쪽 정렬): 줄은 끝까지 다 차지 않으므로, 가장 길게 나간 줄 끝이 오른쪽 끝에 가깝다
  const raggedR = Math.max(p95, ...ends.filter(e => e <= p95 + S));
  // 양쪽 정렬 문서인가: 꽉 찬 줄이 오른쪽 끝에 딱 맞춰져 있으면 그렇다. 그런 문서에서는 끝까지 안 찬 줄 = 문단 끝.
  const flush = all.filter(l => Math.abs(l.x1 - flushR) < 0.8).length;
  const justified = flush >= Math.max(3, all.length * 0.15);
  const R = Math.max(L + 50, justified ? flushR : raggedR);
  const center = (L + R) / 2;
  // 기본 줄 간격(기준선 사이)
  // 글자 크기별 줄 간격: 그 크기의 이웃 줄 사이 거리 중, 충분히 자주 나오는 것 가운데 가장 작은 값(문단 안 줄 간격)
  const rawOf = (l) => l.chars.find(c => !c.ws)?.rawSize ?? l.size;
  function pitchFor(size) {
    const diffs = [];
    for (const pg of pages) for (let i = 1; i < pg.lines.length; i++) { const a = pg.lines[i - 1], b = pg.lines[i]; if (Math.abs(a.size - size) < 0.3 && Math.abs(b.size - size) < 0.3 && b.y - a.y > size * 0.9 && b.y - a.y < size * 3.2) diffs.push(b.y - a.y); }
    const hist = new Map(); for (const d of diffs) { const k = Math.round(d * 10) / 10; hist.set(k, (hist.get(k) || 0) + 1); }
    const near = (k) => [...hist].filter(([v]) => Math.abs(v - k) <= 0.15).reduce((a, [, c]) => a + c, 0);
    const maxC = Math.max(0, ...[...hist.keys()].map(near));
    return maxC >= 2 ? [...hist.keys()].filter(k => near(k) >= Math.max(2, maxC * 0.3)).sort((a, b) => a - b)[0] : null;
  }
  const Sraw = mode(all.filter(l => Math.abs(l.size - S) < 0.3).map(rawOf), 0.01) || S;
  const P = pitchFor(S) || S * 1.6;
  const ratio0 = P / Sraw;
  const ratios = new Map();
  for (const sz of new Set(all.map(l => l.size))) { const p = pitchFor(sz); const raw = mode(all.filter(l => l.size === sz).map(rawOf), 0.01) || sz; ratios.set(sz, p ? p / raw : ratio0); }
  const ratioOf = (sz) => ratios.get(sz) ?? ratio0;
  const pitchOf = (l) => ratioOf(l.size) * rawOf(l);
  const pct = Math.round(ratio0 * 100);
  const over = (s) => s * ratioOf(s) - 0.85 * s;     // 기준선 아래로 남는 줄 높이 (한글: 줄 위 → 기준선 0.85×크기)

  // 본문 위·아래 끝
  const pageTop = (p) => Math.min(p.lines.length ? p.lines[0].y - 0.85 * p.lines[0].size : 1e9, ...p.tables.map(t => t.y0), ...(p.blockImages || []).map(im => im.y0));
  const pageBottom = (p) => Math.max(p.lines.length ? p.lines.at(-1).y + over(p.lines.at(-1).size) : -1e9, ...p.tables.map(t => t.y1), ...(p.blockImages || []).map(im => im.y1));
  const topBase = Math.min(...pages.filter(p => p.lines.length || p.tables.length || p.blockImages?.length).map(pageTop));
  const bodyTop = Math.max(10, topBase);
  const bodyBottom = Math.max(...pages.filter(p => p.lines.length || p.tables.length || p.blockImages?.length).map(pageBottom));
  const page = { w: W, h: H, left: L, right: Math.max(10, W - R), top: bodyTop, bottom: Math.max(10, H - bodyBottom - 1) };

  const lineToPage = new Map(); pages.forEach(pg => pg.lines.forEach(l => lineToPage.set(l, pg)));
  const blockR = (l, x0b = l.x0) => {
    const mates = (lineToPage.get(l)?.lines ?? []).filter(q => q !== l && (Math.abs(q.x0 - l.x0) < 1.5 || Math.abs(q.x0 - x0b) < 1.5));
    if (!mates.length) return R + 1;   // 같은 왼쪽 끝을 가진 줄이 없으면 본문 오른쪽 끝 (짧은 한 줄을 꽉 찬 줄로 보지 않게)
    return Math.min(R + 1, Math.max(l.x1, ...mates.map(q => q.x1)));
  };
  const paras = [];
  const newPara = (line, extra = {}) => {
    const p = { lines: [line], before: 0, pageBreak: false, ...extra };
    paras.push(p); return p;
  };
  // 목록 표시(· • ● ▸ ※ ① 1. Q1. 등)로 시작하는 줄: 앞 문단도 목록 표시로 시작했으면 새 항목이다
  const lineText = (l) => l.chars.map(c => c.c).join('').trimStart();
  const MARK = /^([·•●○◦■□▪▸▶►✓✔※\-–*]|[\u2460-\u2473\u3260-\u327F]|\(?\d{1,2}[.)]\s|[A-Za-z]\d{0,2}[.)]\s)/;
  const marked = (l) => MARK.test(lineText(l));
  const newItem = (line, first) => marked(line) && marked(first);
  let cur = null, prev = null, prevBottom = null;
  const sameCols = (a, b) => a.xs.length === b.xs.length && a.xs.every((x, i) => Math.abs(x - b.xs[i]) < 1.5);
  // 쪽 나눔: 앞 쪽 아래가 많이 비어 있을 때만 '쪽 나눔'으로 옮긴다.
  // 앞 쪽이 거의 찼으면 자연스럽게 넘어간 것이므로 흘러가게 둔다 (한글에서 줄이 조금만 밀려도 빈 쪽이 생기지 않게).
  const fullPage = (pi) => !hancom && pi > 0 && bodyBottom - pageBottom(pages[pi - 1]) < 3 * ratio0 * S;
  pages.forEach((pg, pi) => {
    const startIdx = paras.length;
    let afterImg = false;
    const blocks = [...pg.lines.map(l => ({ y: l.y - 0.85 * l.size, l })), ...pg.tables.map(t => ({ y: t.y0, t })), ...(pg.blockImages || []).map(img => ({ y: img.y0, img }))].sort((a, b) => a.y - b.y);
    blocks.forEach((b, bi) => {
      const firstOnPage = bi === 0;
      const lastOnPage = bi === blocks.length - 1;
      if (b.img) {
        const im = b.img;
        const gap = Math.max(0, im.y0 - (firstOnPage || prevBottom == null ? bodyTop : prevBottom));
        const np = { k: 'img', data: im.data, ext: im.ext, mime: im.mime, w: im.w, h: im.h, pxW: im.pxW, pxH: im.pxH, left: Math.max(0, im.x0 - L), x0: im.x0, y0: im.y0, before: gap, pageBreak: firstOnPage && paras.length > 0 && !fullPage(pi), endOfPage: lastOnPage };
        paras.push(np); cur = null; prev = null; prevBottom = im.y1; afterImg = true;
        return;
      }
      if (b.t) {
        // 앞 쪽 끝에서 이어지는 표 (열이 같으면 한 표로 잇는다)
        const last = paras.at(-1);
        if (firstOnPage && last?.k === 'tbl' && last.endOfPage && sameCols(last.parts.at(-1), b.t)) { last.parts.push(b.t); last.endOfPage = lastOnPage; prevBottom = b.t.y1; prev = null; cur = null; afterImg = false; return; }
        const np = { k: 'tbl', parts: [b.t], before: 0, pageBreak: firstOnPage && paras.length > 0 && !fullPage(pi), endOfPage: lastOnPage };
        const gap = b.t.y0 - (firstOnPage || prevBottom == null ? bodyTop : prevBottom);
        if (afterImg) { np.before = Math.max(0, gap); afterImg = false; } else addGap(np, gap, null);
        paras.push(np); cur = null; prev = null; prevBottom = b.t.y1;
        return;
      }
      const line = b.l;
      let cont = false;
      if (prev && cur) {
        const sameSize = Math.abs(line.size - prev.size) < 0.6;
        // 같은 쪽에서 같은 왼쪽 끝을 가진 줄들의 오른쪽 끝 = 그 글 상자의 오른쪽 끝
        // 다음 줄이 더 왼쪽에서 시작하면(첫 줄 들여쓰기) 앞 줄은 본문 오른쪽 끝까지 차 있어야 이어지는 줄이다
        const Rb = line.x0 < prev.x0 - 1.5 && cur.lines.length === 1 ? R + 1 : blockR(prev, cur.lines[0]?.x0 ?? prev.x0);
        const roomLeft = Rb - prev.x1;
        const fits = justified ? roomLeft < Math.max(0.8, 0.12 * prev.size) : roomLeft < line.firstWordW + 0.6 * line.size;   // 다음 줄 첫 낱말이 앞 줄에 안 들어감 → 이어지는 줄
        const contX = cur.lines.length > 1 ? cur.lines[1].x0 : null;
        const xOk = contX != null ? Math.abs(line.x0 - contX) < 1.5 : line.x0 <= cur.lines[0].x0 + 1.5 || Math.abs(line.x0 - L) < 1.5;
        const centered = Math.abs((prev.x0 + prev.x1) / 2 - center) < prev.size && prev.x0 - L > 2 * prev.size;
        if (newItem(line, cur.lines[0])) cont = false;
        else if (firstOnPage) cont = sameSize && fits && xOk && !centered;
        else {
          const gap = line.y - prev.y;
          cont = sameSize && fits && xOk && !centered && Math.abs(gap - (cur.pitch ?? pitchOf(prev))) < 0.25 * prev.size && (cur.lines.length > 1 ? Math.abs(gap - cur.pitch) < 0.25 * prev.size : true);
        }
      }
      if (cont) { if (!firstOnPage && cur.lines.length === 1) cur.pitch = line.y - prev.y; cur.lines.push(line); }
      else {
        const np = { lines: [line], before: 0, pageBreak: firstOnPage && paras.length > 0 && !fullPage(pi), flowTop: firstOnPage && fullPage(pi), mid: !firstOnPage };
        const top = line.y - 0.85 * line.size;
        const gap = top - (firstOnPage || prevBottom == null ? bodyTop : prevBottom);
        if (afterImg) { np.before = Math.max(0, gap); afterImg = false; } else addGap(np, gap, cur);
        paras.push(np); cur = np;
      }
      prev = line; prevBottom = line.y + over(line.size);
    });
    if (pg.floatImages?.length && paras[startIdx]) paras[startIdx].floats = pg.floatImages;
  });

  // 쪽 맨 위에서는 워드가 문단 위 간격을 지우므로, 흘러 넘어간 문단은 같은 모양 문단의 위 간격을 빌려 온다
  const looks = (p) => { const c = p.lines[0].chars.find(x => !x.ws); return `${p.lines[0].size}|${!!c?.bold}|${Math.round(p.lines[0].x0)}`; };
  for (const p of paras) if (p.flowTop) {
    const same = paras.filter(q => q.mid && q.lines && !q.emptyBefore && looks(q) === looks(p)).map(q => q.before || 0).sort((a, b) => a - b);
    if (same.length) p.before = same[same.length >> 1];
  }

  // 문단 사이 빈 줄: 기본 줄 높이의 배수면 빈 문단으로, 아니면 위 간격으로
  function addGap(p, gap, prevPara) {
    const lineH = S * ratio0;
    if (gap < 0.2) { if (gap < -0.2 && prevPara) prevPara.squeeze = gap; return; }
    const k = Math.round(gap / lineH);
    if (k >= 1 && Math.abs(gap - k * lineH) < 0.2 * S) { p.emptyBefore = k; return; }
    p.before = gap;
  }

  // 한글 줄 나눔 방식: 줄이 바뀌는 자리가 모두 빈칸이면 '어절' 단위, 낱말 중간에서 바뀌면 '글자' 단위
  const breakInfo = (p) => { const n = p.lines.length - 1; const sp = p.lines.slice(0, -1).filter(l => l.trailingSpace).length; return { n, sp }; };
  // 문단 속성 정하기
  const out = [];
  for (const p of paras) {
    for (let k = 0; k < (p.emptyBefore || 0); k++) out.push({ align: justified ? 'JUSTIFY' : 'LEFT', left: 0, right: 0, indent: 0, before: 0, pct, size: S, runs: [], pageBreak: p.pageBreak && k === 0, font: (p.lines?.[0] ?? everyLine[0]).chars.find(c => !c.ws)?.font });
    if (p.k === 'img') {
      const item = { k: 'img', data: p.data, ext: p.ext, mime: p.mime, w: p.w, h: p.h, pxW: p.pxW, pxH: p.pxH, left: p.left, x0: p.x0, y0: p.y0, before: p.before || 0, pageBreak: p.pageBreak && !p.emptyBefore };
      if (p.floats) item.floats = p.floats;
      out.push(item); continue;
    }
    if (p.k === 'tbl') {
      const item = { ...tableOut(p), before: p.before || 0, pageBreak: p.pageBreak && !p.emptyBefore };
      if (p.floats) item.floats = p.floats;
      out.push(item); continue;
    }
    const f = p.lines[0], s = p.lines[1];
    let align = justified ? 'JUSTIFY' : 'LEFT', left = 0, indent = 0;   // 오른쪽 끝이 들쭉날쭉한 문서는 왼쪽 정렬
    // 상자·표 안처럼 본문보다 좁은 글: 오른쪽 여백으로 폭을 맞춘다
    const Rb = Math.max(...p.lines.map(l => blockR(l, f.x0)));
    const right = R - Rb > 1.5 * f.size && p.lines.length > 1 ? R - Rb : 0;
    if (p.lines.length === 1 && Math.abs((f.x0 + f.x1) / 2 - center) < f.size && f.x0 - L > 2 * f.size) align = 'CENTER';
    else if (p.lines.length === 1 && Math.abs(f.x1 - R) < 1 && f.x0 - L > 2 * f.size) align = 'RIGHT';
    else {
      if (p.lines.length > 1 && p.lines.slice(0, -1).some(l => Rb - l.x1 > 1.2 * l.size)) align = 'LEFT';
      if (s) { left = Math.max(0, s.x0 - L); indent = f.x0 - s.x0; }
      else left = Math.max(0, f.x0 - L);
      if (left < 1) left = 0; if (Math.abs(indent) < 1) indent = 0;
    }
    const chars = [];
    for (const l of p.lines) for (const c of l.chars) if (c.white) { c.color = '000000'; c.white = false; report.whiteText++; }
    // 줄을 이을 때: 앞 줄 끝에 빈칸이 있었으면 빈칸을 넣는다. 정보가 없으면 영문·숫자끼리 만날 때만 넣는다(한글은 낱말 중간에서도 줄이 바뀐다).
    p.lines.forEach((l, i) => {
      if (i) {
        const prevL = p.lines[i - 1], a = chars.at(-1)?.c, b = l.chars[0]?.c;
        if (prevL.trailingSpace || (a && b && /[A-Za-z0-9,.;:!?)]/.test(a) && /[A-Za-z0-9(]/.test(b))) chars.push({ ...chars.at(-1), c: ' ', ws: true });
      }
      chars.push(...l.chars);
    });
    let pp = Math.round(ratioOf(f.size) * 100);
    if (p.lines.length > 1 && p.pitch) pp = Math.round(p.pitch / rawOf(f) * 100);
    const bi = breakInfo(p);
    // 줄 바뀜이 모두 빈칸 자리면 '어절' 단위로 둔다. 원본이 글자 단위였어도 빈칸에서 끊겼다면 다음 낱말 첫 글자가 안 들어갔다는 뜻이라 어절 단위로도 같은 자리에서 끊긴다.
    const wordBreak = bi.n > 0 && bi.sp === bi.n;
    const item = { align, left, right, indent, wordBreak, before: p.before || 0, pct: pp, size: f.size, runs: toRuns(chars), pageBreak: p.pageBreak && !p.emptyBefore };
    if (p.floats) item.floats = p.floats;
    out.push(item);
  }
  // ── 표 → 칸마다 문단 ──
  function joinLines(lines) {
    const chars = [];
    lines.forEach((l, i) => {
      if (i) {
        const prevL = lines[i - 1], a = chars.at(-1)?.c, b = l.chars[0]?.c;
        if (prevL.trailingSpace || (a && b && /[A-Za-z0-9,.;:!?)]/.test(a) && /[A-Za-z0-9(]/.test(b))) chars.push({ ...chars.at(-1), c: ' ', ws: true });
      }
      chars.push(...l.chars);
    });
    return chars;
  }
  function cellParas(cell) {
    const ls = cell.lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const cImgs = (cell.images || []).sort((a, b) => a.y0 - b.y0);
    if (!ls.length && !cImgs.length) return { paras: [], mar: { top: 1, bottom: 1, left: 1.5, right: 1.5 }, vAlign: 'top' };
    if (!ls.length && cImgs.length) {
      const padL = Math.max(0.5, Math.min(8, Math.min(...cImgs.map(im => im.x0 - cell.x0))));
      const top = Math.max(0, Math.min(30, cImgs[0].y0 - cell.y0));
      return {
        paras: cImgs.map((im, i) => ({ k: 'img', data: im.data, ext: im.ext, mime: im.mime, w: im.w, h: im.h, pxW: im.pxW, pxH: im.pxH, left: Math.max(0, im.x0 - (cell.x0 + padL)), before: i ? Math.max(0, im.y0 - cImgs[i - 1].y1) : 0 })),
        mar: { top, bottom: 0.5, left: padL, right: padL }, vAlign: 'top',
      };
    }
    // 칸 안쪽 여백: 왼쪽·오른쪽 가운데 더 가까운 쪽 (오른쪽 정렬한 숫자 칸에서 여백을 너무 크게 잡지 않게)
    const padL = Math.max(0.5, Math.min(8, Math.min(...ls.map(l => l.x0 - cell.x0)), Math.min(...ls.map(l => cell.x1 - l.x1))));
    const padR = padL;
    const innerL = cell.x0 + padL, innerR = cell.x1 - padR;
    const Rc = ls.length > 1 ? Math.max(...ls.map(l => l.x1)) : innerR;
    const groups = [];
    let cp = null, pv = null;
    for (const l of ls) {
      let cont = false;
      if (pv && cp) {
        const gap = l.y - pv.y;
        const contX = cp.lines.length > 1 ? cp.lines[1].x0 : cp.lines[0].x0;
        cont = !newItem(l, cp.lines[0]) && Math.abs(l.size - pv.size) < 0.6 && innerR - pv.x1 < l.firstWordW + 0.6 * l.size && Math.abs(gap - (cp.pitch ?? (cellR ? cellR * rawOf(pv) : pitchOf(pv)))) < 0.3 * pv.size && Math.abs(l.x0 - contX) < 2 && !(Math.abs((pv.x0 + pv.x1) / 2 - (innerL + innerR) / 2) < 1.5 && pv.x0 - innerL > 2);
      }
      if (cont) { if (cp.lines.length === 1) cp.pitch = l.y - pv.y; cp.lines.push(l); }
      else { cp = { lines: [l], before: pv ? Math.max(0, (l.y - 0.85 * l.size) - (pv.y + over(pv.size))) : 0 }; groups.push(cp); }
      pv = l;
    }
    const paras = groups.map(g => {
      const f = g.lines[0], s2 = g.lines[1];
      let align = 'LEFT', left = 0, indent = 0;
      const mid = (f.x0 + Math.max(...g.lines.map(l => l.x1))) / 2;
      if (Math.abs(mid - (innerL + innerR) / 2) < 1.5 && f.x0 - innerL > 1.5) align = 'CENTER';
      else if (Math.abs(f.x1 - innerR) < 1.5 && f.x0 - innerL > 1.5 && g.lines.length === 1) align = 'RIGHT';
      else {
        if (g.lines.length > 1 && g.lines.slice(0, -1).every(l => Math.abs(l.x1 - Rc) < 0.8)) align = 'JUSTIFY';
        if (s2) { left = Math.max(0, s2.x0 - innerL); indent = f.x0 - s2.x0; } else left = Math.max(0, f.x0 - innerL);
        if (left < 1) left = 0; if (Math.abs(indent) < 1) indent = 0;
      }
      for (const l of g.lines) for (const c of l.chars) if (c.white && !cell.fill) { c.color = '000000'; c.white = false; report.whiteText++; }
      const chars = joinLines(g.lines);
      let pp = Math.round((cellR ?? ratioOf(f.size)) * 100);
      if (g.lines.length > 1 && g.pitch) pp = Math.round(g.pitch / rawOf(f) * 100);
      const n = g.lines.length - 1, sp = g.lines.slice(0, -1).filter(l => l.trailingSpace).length;
      const y0 = f.y - 0.85 * f.size, y1 = g.lines.at(-1).y + over(g.lines.at(-1).size);
      return { align, left, right: 0, indent, wordBreak: n > 0 && sp === n, before: g.before, pct: pp, size: f.size, runs: toRuns(chars), _y0: y0, _y1: y1 };
    });
    if (cImgs.length) {
      for (const im of cImgs) paras.push({ k: 'img', data: im.data, ext: im.ext, mime: im.mime, w: im.w, h: im.h, pxW: im.pxW, pxH: im.pxH, left: Math.max(0, im.x0 - innerL), before: 0, _y0: im.y0, _y1: im.y1 });
      paras.sort((a, b) => a._y0 - b._y0);
      paras.forEach((p, i) => { p.before = i ? Math.max(0, p._y0 - paras[i - 1]._y1) : 0; });
    }
    const topY = Math.min(ls[0].y - 0.85 * ls[0].size, ...cImgs.map(im => im.y0));
    const botY = Math.max(ls.at(-1).y + over(ls.at(-1).size), ...cImgs.map(im => im.y1));
    for (const p of paras) { delete p._y0; delete p._y1; }
    const first = ls[0];
    const topGap = topY - cell.y0;
    const botGap = cell.y1 - botY;
    let vAlign = 'top', top = Math.max(0, Math.min(30, topGap)), bottom = 0.5;
    if (topGap > 2 && Math.abs(topGap - botGap) < Math.max(2, 0.25 * first.size)) { vAlign = 'center'; top = bottom = Math.max(0, Math.min(topGap, botGap)) * 0.5; }
    return { paras, mar: { top, bottom, left: padL, right: padR }, vAlign };
  }
  function tableOut(p) {
    const t0 = p.parts[0];
    const cols = t0.xs.slice(1).map((x, i) => x - t0.xs[i]);
    const rows = [], cells = [];
    let rowOff = 0, header = 0;
    const rowText = (t, r) => t.grid.cells.filter(c => c.row === r).map(c => c.lines.map(l => l.chars.map(x => x.c).join('')).join('')).join('|');
    p.parts.forEach((t, pi) => {
      let skip = 0;
      // 다음 쪽에 머리 줄이 되풀이되어 있으면 한 번만 둔다
      if (pi > 0 && rowText(t, 0) && rowText(t, 0) === rowText(t0, 0)) { skip = 1; header = 1; }
      t.ys.slice(1).forEach((y, r) => { if (r >= skip) rows.push(y - t.ys[r]); });
      for (const c of t.grid.cells) {
        if (c.row < skip) continue;
        const cp = cellParas(c);
        cells.push({ row: c.row - skip + rowOff, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, fill: c.fill, borders: c.borders, ...cp });
      }
      rowOff += t.ys.length - 1 - skip;
    });
    return { k: 'tbl', left: Math.max(0, t0.x0 - L), cols, rows, cells, headerRows: header };
  }

  let spaceEm = null;
  if (!hancom) {
    spaceEm = {};
    const by = new Map(); for (const pg of pages) for (const [f, w] of pg.spaces) { if (!by.has(f)) by.set(f, []); by.get(f).push(w); }
    for (const [f, ws] of by) { ws.sort((a, b) => a - b); spaceEm[f] = ws[ws.length >> 1]; }
  }
  return { page, paras: out, spaceEm, report: { ...report, bodySize: S, lineSpacing: pct, paragraphs: out.length, producer: producer.trim() } };
}
