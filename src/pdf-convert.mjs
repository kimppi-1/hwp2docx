// PDF → 한글(.hwpx)·워드(.docx)
// pdf-read가 되살린 문단 모델을 한글 값 그대로(글꼴·크기·색·굵기·정렬·여백·줄 간격·쪽 나눔) 쓴다.
import { readPdf } from './pdf-read.mjs';
import { SPACE_ADVANCE } from './font-metrics.mjs';
import { buildHwpx } from './hwpx-write.mjs';
import { buildDocx } from './docx-write.mjs';
import { STYLE_TEMPLATE } from './style-template.mjs';

const U = (pt) => Math.round(pt * 100);     // pt → HWPUNIT
const ALIGN_WORD = { JUSTIFY: 'both', LEFT: 'left', RIGHT: 'right', CENTER: 'center' };
const ALIGN_HWP = { JUSTIFY: 0, LEFT: 1, RIGHT: 2, CENTER: 3 };

// 워드 모델(docx-read 형식) → hwpx-write '한글 값 그대로' 모드
function wordModel(m) {
  const tw = (pt) => pt * 20;
  const split = (v) => v > 60 ? v - 42.52 : v / 2;   // 종이 끝 → 머리말까지 거리
  const pg = m.page;
  const rpr = (r) => ({ fonts: { eastAsia: r.font, ascii: r.font, hAnsi: r.font, cs: r.font }, sz: Math.round(r.size * 2), color: r.color, b: r.bold, i: r.italic, spaceEm: m.spaceEm ? (m.spaceEm[r.font] ?? SPACE_ADVANCE[r.font] ?? 0.5) : undefined });
  const mapFloat = (f) => {
    if (f.type === 'line') return { type: 'line', x1: tw(f.x1), y1: tw(f.y1), x2: tw(f.x2), y2: tw(f.y2), w: tw(f.w), color: f.color };
    if (f.type === 'rect') return { type: 'rect', x: tw(f.x0), y: tw(f.y0), w: tw(f.w), h: tw(f.h), ratio: f.ratio || 0, fill: f.fill, stroke: f.stroke ? { color: f.stroke.color, w: tw(f.stroke.w) } : null, behind: f.behind };
    return { ...f, x: tw(f.x0), y: tw(f.y0), w: tw(f.w), h: tw(f.h) };
  };
  const floatsOf = (p) => {
    const all = [...(p.floats || []), ...(p._shapes || [])];
    return all.length ? all.map(mapFloat) : undefined;
  };
  const para = (p) => {
    const ppr = {
      jc: ALIGN_WORD[p.align] ?? 'both',
      ind: { left: tw(p.left), right: tw(p.right || 0), first: tw(p.indent) },
      spacing: { before: tw(p.before), after: 0 },
      hwpLine: { type: 'PERCENT', value: p.pct },
      pageBreakBefore: p.pageBreak,
      hwpWordBreak: !!p.wordBreak,
    };
    const base = { font: p.runs[0]?.font ?? p.font ?? '함초롬바탕', size: p.size, color: '000000', bold: false, italic: false };
    const fl = floatsOf(p);
    return { k: 'p', ppr, markR: rpr(p.runs.at(-1) ?? base), runs: p.runs.map(r => ({ t: 'text', text: r.text, rpr: rpr(r) })), ...(fl ? { floats: fl } : {}) };
  };
  const img = (im) => {
    const fl = floatsOf(im);
    return { k: 'img', data: im.data, ext: im.ext || 'png', mime: im.mime || 'image/png', w: tw(im.w), h: tw(im.h), pxW: im.pxW, pxH: im.pxH, left: tw(im.left || 0), before: tw(im.before || 0), pageBreak: im.pageBreak, ...(fl ? { floats: fl } : {}) };
  };
  const bord = (b) => (b ? { type: 'single', sz: Math.max(1, Math.round(b.w * 8)), color: b.color } : undefined);
  const table = (t) => {
    const byRow = t.rows.map(() => []);
    for (const c of t.cells) byRow[c.row]?.push(c);
    const rows = t.rows.map((h, r) => {
      const cells = byRow[r].sort((a, b) => a.col - b.col).map(c => ({
        col: c.col, span: c.colSpan, rowSpan: c.rowSpan,
        borders: { top: bord(c.borders.top), bottom: bord(c.borders.bottom), left: bord(c.borders.left), right: bord(c.borders.right) },
        shade: c.fill, vAlign: c.vAlign,
        mar: { top: tw(c.mar.top), bottom: tw(c.mar.bottom), left: tw(c.mar.left), right: tw(c.mar.right) },
        blocks: c.paras.map(p => (p.k === 'img' ? img(p) : para(p))),
      }));
      // hwpx-write는 칸 높이에 안 여백·아래 선 굵기를 더하므로 미리 뺀다
      const mar = Math.max(0, ...cells.map(c => c.mar.top + c.mar.bottom));
      const bw = Math.max(0, ...cells.map(c => (c.borders.bottom ? c.borders.bottom.sz / 8 * 20 : 0)));
      return { h: Math.max(20, tw(h) - mar - bw), hRule: 'atLeast', header: r < (t.headerRows || 0), cells };
    });
    const fl = floatsOf(t);
    return { k: 'tbl', grid: t.cols.map(tw), rows, borders: {}, cellMar: { top: 0, bottom: 0, left: 0, right: 0 }, jc: 'left', ind: tw(t.left), before: tw(t.before || 0), pageBreak: t.pageBreak, ...(fl ? { floats: fl } : {}) };
  };
  const blocks = m.paras.map(p => (p.k === 'tbl' ? table(p) : p.k === 'img' ? img(p) : para(p)));
  return {
    sumSpacing: true, defaultTab: 800,
    // 한글 기본(위 20mm + 머리말 15mm, 아래 15mm + 꼬리말 15mm)처럼 여백을 머리말·꼬리말 칸과 나눠 둔다 (보이는 위치는 같다)
    sections: [{ page: { w: tw(pg.w), h: tw(pg.h), left: tw(pg.left), right: tw(pg.right), top: tw(pg.top), header: tw(split(pg.top)), bottom: tw(pg.bottom), footer: tw(split(pg.bottom)), gutter: 0, colGap: 0, cols: 1, landscape: pg.w > pg.h }, blocks }],
  };
}

// 한글 파일 모델(hwp-parse 형식) → docx-write
function hwpModel(m) {
  const t = JSON.parse(JSON.stringify(STYLE_TEMPLATE));
  const lead = t.lead; delete t.lead; delete t.bodyParaShape; delete t.baseCharShape;
  const baseCs = t.charShapes[0], basePs = t.paraShapes[0];
  const faceId = (name) => {
    let i = t.faces[0].findIndex(f => (f?.name ?? f) === name);
    if (i < 0) { for (const list of t.faces) list.push({ name }); i = t.faces[0].length - 1; }
    return i;
  };
  const csKey = new Map(), psKey = new Map();
  const cs = (r) => {
    const k = [r.font, r.size, r.color, r.bold, r.italic].join('|');
    if (!csKey.has(k)) {
      const f = faceId(r.font);
      const spaceEm = m.spaceEm ? (m.spaceEm[r.font] ?? SPACE_ADVANCE[r.font] ?? 0.5) : undefined;
      t.charShapes.push({ ...baseCs, face: Array(7).fill(f), ratio: Array(7).fill(100), spacing: Array(7).fill(0), relSize: Array(7).fill(100), offset: Array(7).fill(0), size: U(r.size), bold: !!r.bold, italic: !!r.italic, underline: 0, color: r.color, ...(spaceEm != null ? { spaceEm } : {}) });
      csKey.set(k, t.charShapes.length - 1);
    }
    return csKey.get(k);
  };
  const ps = (p) => {
    const left = p.indent < 0 ? p.left + p.indent : p.left;   // 워드식(왼쪽 + 첫 줄) → 한글식(왼쪽 여백, 들여쓰기 음수 = 내어쓰기)
    const k = [p.align, U(left), U(p.right || 0), U(p.indent), U(p.before), p.pct, p.wordBreak ? 1 : 0].join('|');
    if (!psKey.has(k)) {
      t.paraShapes.push({ ...basePs, align: ALIGN_HWP[p.align] ?? 0, lineSpacingType: 0, lineSpacing: p.pct, left: U(Math.max(0, left)), right: U(p.right || 0), indent: U(p.indent), before: U(p.before), after: 0, pageBreakBefore: false, breakHangul: p.wordBreak ? 0 : 1, autoSpaceEn: false, autoSpaceNum: false });
      psKey.set(k, t.paraShapes.length - 1);
    }
    return psKey.get(k);
  };
  const pg = m.page;
  const secd = { ...lead.find(x => x.ctrl.id === 'secd').ctrl, page: { width: U(pg.w), height: U(pg.h), left: U(pg.left), right: U(pg.right), top: U(pg.top), bottom: U(pg.bottom), header: 0, footer: 0, gutter: 0, landscape: false } };
  const cold = lead.find(x => x.ctrl.id === 'cold')?.ctrl ?? { id: 'cold', count: 1, sameWidth: true, gap: 0 };
  const mkPara = (p, lead) => {
    const base = { font: p.runs?.[0]?.font ?? p.font ?? '함초롬바탕', size: p.size ?? 10, color: '000000', bold: false, italic: false };
    const items = lead ? lead(cs(base)) : [];
    let pos = items.length * 8;
    for (const fl of [...(p.floats || []), ...(p._shapes || [])]) {
      if (fl.type === 'line') {
        const fCtrl = { id: 'line', x1: U(fl.x1), y1: U(fl.y1), x2: U(fl.x2), y2: U(fl.y2), w: U(fl.w), color: fl.color };
        items.push({ t: 'ctrl', ctrl: fCtrl, cs: cs(base), pos }); pos += 8; continue;
      }
      if (fl.type === 'rect') {
        const fCtrl = { id: 'rect', x: U(fl.x0), y: U(fl.y0), width: U(fl.w), height: U(fl.h), ratio: fl.ratio || 0, fill: fl.fill, stroke: fl.stroke ? { color: fl.stroke.color, w: U(fl.stroke.w) } : null, behind: fl.behind };
        items.push({ t: 'ctrl', ctrl: fCtrl, cs: cs(base), pos }); pos += 8; continue;
      }
      const fCtrl = { id: 'pic ', inline: false, wrap: fl.behind ? 2 : 3, vertRel: 0, horzRel: 0, vertAlign: 0, horzAlign: 0, x: U(fl.x0), y: U(fl.y0), width: U(fl.w), height: U(fl.h), z: 0, marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0, data: fl.data, ext: fl.ext || 'png', mime: fl.mime || 'image/png' };
      items.push({ t: 'ctrl', ctrl: fCtrl, cs: cs(base), pos }); pos += 8;
    }
    for (const r of p.runs || []) { items.push({ t: 'text', text: r.text, cs: cs(r), pos }); pos += r.text.length; }
    const sz = U(p.size ?? 10);
    return { paraShape: ps(p), style: 0, divide: p.pageBreak ? 4 : 0, items, endCharShape: cs(p.runs?.at(-1) ?? base), lineSegs: [{ pos: 0, y: 0, height: sz, textHeight: sz, baseline: Math.round(sz * 0.85), gap: Math.round(sz * ((p.pct || 160) / 100 - 1)), x: 0, width: 0 }] };
  };
  const imgPara = (im, lead) => {
    const ctrl = { id: 'pic ', inline: true, wrap: 0, vertRel: 2, horzRel: 2, vertAlign: 0, horzAlign: 0, x: 0, y: 0,
      width: U(im.w), height: U(im.h), z: 0,
      marginLeft: U(im.left || 0), marginRight: 0, marginTop: U(im.before || 0), marginBottom: 0,
      data: im.data, ext: im.ext || 'png', mime: im.mime || 'image/png' };
    const host = mkPara({ align: 'LEFT', left: 0, indent: 0, before: 0, pct: 100, size: 1, runs: [], pageBreak: im.pageBreak, floats: im.floats, _shapes: im._shapes }, lead);
    host.items.push({ t: 'ctrl', ctrl, cs: host.endCharShape, pos: host.items.length * 8 });
    host.lineSegs[0].gap = 0;
    return host;
  };
  // 표 → 한글 표 개체(글자처럼 취급) 하나를 담은 문단
  const bfKey = new Map();
  const line = (b) => (b ? { type: 'solid', widthMm: Math.max(0.1, b.w * 0.3528), color: b.color } : { type: 'none', widthMm: 0.1, color: '000000' });
  const borderFill = (c) => {
    const bf = { slash: 0, backSlash: 0, left: line(c.borders.left), right: line(c.borders.right), top: line(c.borders.top), bottom: line(c.borders.bottom), diagonal: { type: 'none', widthMm: 0.1, color: '000000' }, fill: c.fill };
    const k = JSON.stringify(bf);
    if (!bfKey.has(k)) { t.borderFills.push(bf); bfKey.set(k, t.borderFills.length); }   // 1부터 세는 번호
    return bfKey.get(k);
  };
  const VA = { top: 0, center: 1, bottom: 2 };
  const tablePara = (tb, lead) => {
    const cells = tb.cells.map(c => {
      const hasCenter = c.paras.some(p => p.align === 'CENTER');
      const mL = hasCenter ? Math.min(1.5, c.mar.left) : c.mar.left;
      const mR = hasCenter ? Math.min(1.5, c.mar.right) : c.mar.right;
      return {
        col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan,
        width: U(tb.cols.slice(c.col, c.col + c.colSpan).reduce((a, b) => a + b, 0)),
        height: U(tb.rows.slice(c.row, c.row + c.rowSpan).reduce((a, b) => a + b, 0)),
        padLeft: U(mL), padRight: U(mR), padTop: U(c.mar.top), padBottom: U(c.mar.bottom), ownPadding: true,
        borderFillId: borderFill(c), valign: VA[c.vAlign] ?? 0, textDir: 0, header: c.row < (tb.headerRows || 0),
        paras: (c.paras.length ? c.paras : [{ align: 'LEFT', left: 0, indent: 0, before: 0, pct: 100, size: 10, runs: [] }]).map(p => (p.k === 'img' ? imgPara(p) : mkPara(p))),
      };
    });
    const ctrl = { id: 'tbl ', inline: true, wrap: 0, vertRel: 2, horzRel: 2, vertAlign: 0, horzAlign: 0, x: 0, y: 0,
      width: U(tb.cols.reduce((a, b) => a + b, 0)), height: U(tb.rows.reduce((a, b) => a + b, 0)), z: 0,
      marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0, split: 2, repeatHeader: !!tb.headerRows,
      rows: tb.rows.length, cols: tb.cols.length, cellSpacing: 0, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, borderFillId: 0, cells };
    const host = mkPara({ align: 'LEFT', left: tb.left, indent: 0, before: tb.before || 0, pct: 100, size: 10, runs: [], pageBreak: tb.pageBreak, floats: tb.floats, _shapes: tb._shapes }, lead);
    host.items.push({ t: 'ctrl', ctrl, cs: host.endCharShape, pos: host.items.length * 8 });
    host.lineSegs[0].gap = 0;
    return host;
  };
  const lead0 = (c) => [{ t: 'ctrl', ctrl: secd, cs: c, pos: 0 }, { t: 'ctrl', ctrl: cold, cs: c, pos: 8 }];
  t.sections = [{ paras: m.paras.map((p, i) => (p.k === 'tbl' ? tablePara(p, i === 0 ? lead0 : null) : p.k === 'img' ? imgPara(p, i === 0 ? lead0 : null) : mkPara(p, i === 0 ? lead0 : null))) }];
  return t;
}

// bytes: PDF 내용(Uint8Array), pdfjs: pdf.js 모듈 (pdfjs-dist)
// 결과 보고: 다른 변환기와 같은 모양 { stats, fonts, approximations }
function toReport(r) {
  const notes = [];
  if (r.tables) notes.push({ msg: '표 선·칸 배경으로 표를 되살림', count: r.tables });
  if (r.whiteText) notes.push({ msg: '배경을 옮기지 못한 흰 글씨는 검정으로 바꿈', count: r.whiteText });
  return { stats: { paragraphs: r.paragraphs, pages: r.pages, tables: r.tables || 0, cells: 0 }, fonts: r.fonts, approximations: notes, pdf: r };
}
// 오류 코드: e.code === 'NO_TEXT' (글자가 없는 PDF: 스캔·그림), 'PASSWORD' (암호)
export async function pdfToHwpx(bytes, pdfjs, opts = {}) {
  const m = await readPdf(bytes, pdfjs, opts);
  const { hwpx } = buildHwpx(wordModel(m), { native: true, fixSpaces: !!m.spaceEm, alignBaselines: false });
  return { hwpx, report: toReport(m.report) };
}
export async function pdfToDocx(bytes, pdfjs, opts = {}) {
  const m = await readPdf(bytes, pdfjs, opts);
  const { docx } = buildDocx(hwpModel(m), { keepPageBreaks: false, target: opts.target });
  return { docx, report: toReport(m.report) };
}
export { readPdf };
