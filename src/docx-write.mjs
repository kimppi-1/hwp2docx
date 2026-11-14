// 문서 모델(HWP에서 읽은 값) → DOCX
// 원칙: 한글 파일에 저장된 수치를 추측 없이 그대로 옮기고, 옮길 수 없는 것은 report에 남긴다.
import { zipSync, strToU8 } from 'fflate';
import { hwpEquationLatex } from './hwp-equation.mjs';
import { latexToOmml } from './latex-omml.mjs';
import { SPACE_ADVANCE, SPACE_ADVANCE_GUESS, HANGUL_ADVANCE, HWP_SPACE } from './font-metrics.mjs';

const tw = (hu) => Math.round(hu / 5);            // HWPUNIT → twips(1/1440인치)
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 한글의 언어별 글꼴 구분: 0 한글, 1 영문, 2 한자, 3 일어, 4 외국어, 5 기호, 6 사용자
function langOf(c) {
  if ((c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3130 && c <= 0x318F) ||
      (c >= 0xA960 && c <= 0xA97F) || (c >= 0xD7B0 && c <= 0xD7FF)) return 0;
  if (c < 0x80) return 1;
  if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0xF900 && c <= 0xFAFF)) return 2;
  if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x31F0 && c <= 0x31FF)) return 3;
  if (c >= 0x00C0 && c <= 0x024F) return 1;
  if ((c >= 0x80 && c <= 0xBF) || (c >= 0x2000 && c <= 0x2BFF) || (c >= 0x2E80 && c <= 0x2FDF) ||
      (c >= 0x3000 && c <= 0x303F) || (c >= 0x3200 && c <= 0x33FF) || (c >= 0xFE30 && c <= 0xFE6F) ||
      (c >= 0xFF00 && c <= 0xFFEF)) return 5;
  return 4;
}

const WBORDER = {
  none: 'nil', solid: 'single', dash: 'dashed', dot: 'dotted', dashDot: 'dotDash', dashDotDot: 'dotDotDash',
  longDash: 'dashed', circle: 'dotted', double: 'double', thinThick: 'thinThickSmallGap', thickThin: 'thickThinSmallGap',
  thinThickThin: 'thinThickThinSmallGap', wave: 'wave', doubleWave: 'doubleWave', thick3D: 'threeDEmboss',
  thick3DRev: 'threeDEngrave', thin3D: 'outset', thin3DRev: 'inset',
};
const UNDERLINE = ['single', 'dash', 'dotted', 'dotDash', 'dotDotDash', 'dashLong', 'dotted', 'double', 'double', 'double', 'double', 'wave', 'wavyDouble'];
const ALIGN = ['both', 'left', 'right', 'center', 'distribute', 'distribute'];
const NUMFMT = ['decimal', 'decimalEnclosedCircle', 'upperRoman', 'lowerRoman', 'upperLetter', 'lowerLetter', 'upperLetter', 'lowerLetter', 'ganada', 'ganada', 'chosung'];

const borderSz = (b) => (!b || b.type === 'none') ? 0 : Math.max(2, Math.min(96, Math.round(b.widthMm * 22.677)));
function borderXml(tag, b, space) {
  if (!b || b.type === 'none') return `<w:${tag} w:val="nil"/>`;
  const sz = borderSz(b);
  return `<w:${tag} w:val="${WBORDER[b.type] ?? 'single'}" w:sz="${sz}" w:space="${space ?? 0}" w:color="${b.color}"/>`;
}

function formatNumber(n, fmt) {
  switch (fmt) {
    case 1: return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n);
    case 2: case 3: {
      const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
      let s = '', v = n; for (const [k, r] of t) while (v >= k) { s += r; v -= k; }
      return fmt === 3 ? s.toLowerCase() : s;
    }
    case 4: return String.fromCharCode(65 + (n - 1) % 26);
    case 5: return String.fromCharCode(97 + (n - 1) % 26);
    case 8: return '가나다라마바사아자차카타파하'[(n - 1) % 14];
    case 10: return 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ'[(n - 1) % 14];
    default: return String(n);
  }
}

export function buildDocx(doc, opts = {}) {
  const report = { approximations: new Map(), fonts: new Set(), stats: { paragraphs: 0, tables: 0, cells: 0 } };
  const note = (msg) => report.approximations.set(msg, (report.approximations.get(msg) || 0) + 1);
  const parts = {};      // 머리말/꼬리말 파일
  const rels = [];
  const numCounters = new Map();

  // ── 글자 모양 → w:rPr ─────────────────────────────────────────────
  const rprCache = new Map();
  function rPr(csId, lang, isSpace, boxGlyph) {
    const key = csId + ':' + lang + (isSpace ? ':' + isSpace : '') + (boxGlyph ? ':box' : '');
    if (rprCache.has(key)) return rprCache.get(key);
    const cs = doc.charShapes[csId] ?? doc.charShapes[0];
    const face = doc.faces[lang]?.[cs.face[lang]] ?? doc.faces[0]?.[cs.face[0]];
    let font = face?.name ?? '바탕';
    // 체크 상자(☐☑☒)는 맑은 고딕·굴림 등에 글자가 없다. 한글은 함초롬돋움으로 대신 그리지만 워드는 Segoe 글꼴로 바꿔 모양이 달라지므로 글꼴을 지정해 준다.
    if (boxGlyph && !font.startsWith('함초롬')) font = '함초롬돋움';
    report.fonts.add(font);
    const sizeHu = cs.size * cs.relSize[lang] / 100;
    const halfPt = Math.round(sizeHu / 50);
    if (Math.abs(halfPt * 50 - sizeHu) > 1) note('글자 크기를 0.5pt 단위로 반올림 (워드는 0.5pt 단위만 지원)');
    let x = `<w:rFonts w:ascii="${esc(font)}" w:hAnsi="${esc(font)}" w:eastAsia="${esc(font)}" w:cs="${esc(font)}"/>`;
    if (cs.bold) x += '<w:b/><w:bCs/>';
    if (cs.italic) x += '<w:i/><w:iCs/>';
    if (cs.strike && cs.strikeShape !== 15) x += (cs.strikeShape >= 7 && cs.strikeShape <= 10) ? '<w:dstrike/>' : '<w:strike/>';
    if (cs.outline) x += '<w:outline/>';
    if (cs.shadow) x += '<w:shadow/>';
    if (cs.emboss) x += '<w:emboss/>';
    if (cs.engrave) x += '<w:imprint/>';
    x += `<w:color w:val="${cs.color}"/>`;
    let sp = Math.round(sizeHu / 100 * cs.spacing[lang] / 100 * 20);      // 자간: 글자 크기의 % → pt
    if (isSpace) {
      // 빈칸 폭 — 한글은 언제나 글자 크기의 1/2. 워드는 앞뒤 글자에 따라 다르게 그린다(실제 워드 출력으로 확인):
      //  · 앞이나 뒤가 한글(동아시아 글자)인 빈칸: 한글 글자 폭의 절반(함초롬 0.485, 나눔스퀘어 0.455 …). 이 빈칸에 준 글자 간격은 두 배로 적용된다.
      //  · 앞뒤가 모두 영문·숫자·문장부호인 빈칸: 글꼴에 들어 있는 빈칸 폭(함초롬 0.3 …). 글자 간격은 준 만큼만 적용된다.
      // 모자라는 만큼 빈칸 뒤 간격으로 보탠다. 워드가 아닌 프로그램은 항상 글꼴의 빈칸 폭을 쓴다(target:'libreoffice').
      const targetSpace = cs.spaceEm ?? HWP_SPACE;
      const jagan = sizeHu / 100 * cs.spacing[lang] / 100 * 20;
      const scale = sizeHu / 100 * cs.ratio[lang] / 100 * 20;
      const fontSpace = SPACE_ADVANCE[font] ?? SPACE_ADVANCE_GUESS[font];
      if (opts.target === 'libreoffice' || isSpace === 'latin') {
        if (fontSpace == null) note(`글꼴 '${font}'의 띄어쓰기 폭을 몰라 영문·숫자 사이 빈칸은 보정하지 않음`);
        else sp = Math.round(jagan + scale * (targetSpace - fontSpace));
      } else {
        // 두 배로 적용되므로 절반만 준다.
        sp = Math.round((jagan + scale * (targetSpace - (HANGUL_ADVANCE[font] ?? 1) / 2)) / 2);
      }
    }
    if (sp) x += `<w:spacing w:val="${sp}"/>`;
    if (cs.ratio[lang] !== 100) x += `<w:w w:val="${cs.ratio[lang]}"/>`;   // 장평
    const pos = Math.round(-cs.offset[lang] / 100 * sizeHu / 50);
    if (pos) x += `<w:position w:val="${pos}"/>`;
    x += `<w:sz w:val="${halfPt}"/><w:szCs w:val="${halfPt}"/>`;
    if (cs.underline === 1) x += `<w:u w:val="${UNDERLINE[cs.underlineShape] ?? 'single'}"${cs.underlineColor ? ` w:color="${cs.underlineColor}"` : ''}/>`;
    else if (cs.underline === 3) note('글자 위 줄(윗줄)은 워드에 없어 생략');
    if (cs.shade) x += `<w:shd w:val="clear" w:color="auto" w:fill="${cs.shade}"/>`;
    if (cs.superscript) x += '<w:vertAlign w:val="superscript"/>';
    else if (cs.subscript) x += '<w:vertAlign w:val="subscript"/>';
    const r = { xml: x, sizeHu };
    rprCache.set(key, r);
    return r;
  }
  const markRpr = (csId) => rPr(csId, 0);

  // 빈칸의 앞(dir=-1)·뒤(dir=1)에서 가장 가까운 '빈칸이 아닌 글자'. 탭·줄바꿈·문단 끝을 만나면 없음(null).
  const isEastAsian = (c) => c != null && ((c >= 0x1100 && c <= 0x11FF) || c >= 0x2E80);
  function neighbour(items, it, chars, ci, dir) {
    for (let k = ci + dir; k >= 0 && k < chars.length; k += dir) { const c = chars[k].codePointAt(0); if (c !== 0x20) return c; }
    for (let n = items.indexOf(it) + dir; n >= 0 && n < items.length; n += dir) {
      const o = items[n];
      if (o.t !== 'text') return null;
      const cs = [...o.text];
      for (let k = dir > 0 ? 0 : cs.length - 1; k >= 0 && k < cs.length; k += dir) { const c = cs[k].codePointAt(0); if (c !== 0x20) return c; }
    }
    return null;
  }
  function runsXml(items) {
    // 같은 글자 모양 + 같은 언어 구분끼리 묶어 run을 만든다
    let out = '', maxSize = 0;
    let cur = null, buf = '';
    const flush = () => { if (buf) out += `<w:r><w:rPr>${cur.xml}</w:rPr><w:t xml:space="preserve">${esc(buf)}</w:t></w:r>`; buf = ''; };
    for (const it of items) {
      if (it.t === 'text') {
        let prevLang = 0;
        const chars = [...it.text];
        for (let ci = 0; ci < chars.length; ci++) {
          const ch = chars[ci];
          const cp = ch.codePointAt(0);
          const lang = cp === 0x20 || cp === 0xA0 ? (prevLang === 0 || prevLang === 1 ? 1 : prevLang) : langOf(cp);
          prevLang = lang;
          let spaceKind = 0;
          if (cp === 0x20) {
            const before = neighbour(items, it, chars, ci, -1), after = neighbour(items, it, chars, ci, 1);
            // 워드 실측: 앞이나 뒤가 한글이면, 또는 문단·줄 맨 앞 빈칸이면(앞 글자 없음) 동아시아 폭. 앞뒤가 모두 영문·숫자·문장부호일 때만 글꼴 빈칸 폭.
            spaceKind = before == null || after == null || isEastAsian(before) || isEastAsian(after) ? 'ea' : 'latin';
          }
          const r = rPr(it.cs, lang, spaceKind, cp >= 0x2610 && cp <= 0x2612);
          if (r.sizeHu > maxSize) maxSize = r.sizeHu;
          if (r !== cur && (!cur || r.xml !== cur.xml)) { flush(); cur = r; }
          buf += ch;
        }
      } else if (it.t === 'tab' || it.t === 'br') {
        flush();
        const r = rPr(it.cs, 0); if (r.sizeHu > maxSize) maxSize = r.sizeHu;
        out += `<w:r><w:rPr>${r.xml}</w:rPr>${it.t === 'tab' ? '<w:tab/>' : '<w:br/>'}</w:r>`;
        cur = null;
      } else if (it.t === 'raw') { flush(); cur = null; out += it.xml; }
    }
    flush();
    return { xml: out, maxSize };
  }

  // ── 문단 모양 → w:pPr ─────────────────────────────────────────────
  function lineHeightOf(para, ps, maxSize, useSegs) {
    // 한글의 줄 간격(줄 높이 + 줄 사이)을 워드의 '고정' 줄 간격으로 옮긴다.
    const segs = para.lineSegs;
    if (useSegs && segs.length) {
      const cnt = new Map(); let best = 0, bestN = 0;
      for (const s of segs) { const v = s.height + s.gap; const n = (cnt.get(v) || 0) + 1; cnt.set(v, n); if (n > bestN) { bestN = n; best = v; } }
      if (cnt.size > 1) note('한 문단 안에서 줄마다 높이가 다른 경우 가장 많이 쓰인 줄 높이로 통일');
      if (best > 0) return { v: best, rule: 'exact' };
    }
    const size = maxSize || 1000;
    switch (ps.lineSpacingType) {
      case 1: return { v: ps.lineSpacing / 2, rule: 'exact' };
      case 2: return { v: size + ps.lineSpacing / 2, rule: 'exact' };
      case 3: return { v: ps.lineSpacing / 2, rule: 'atLeast' };
      default: return { v: size * ps.lineSpacing / 100, rule: 'exact' };
    }
  }

  function pXml(p) {
    const ps = p.ps;
    let x = '<w:pPr>';
    if (ps.keepWithNext || p.keepNext) x += '<w:keepNext/>';
    if (ps.keepLines) x += '<w:keepLines/>';
    if (p.pageBreakBefore || ps.pageBreakBefore) x += '<w:pageBreakBefore/>';
    x += `<w:widowControl w:val="${ps.widowOrphan ? 1 : 0}"/>`;
    const bf = ps.borderFillId ? doc.borderFills[ps.borderFillId - 1] : null;
    if (bf && ['top', 'left', 'bottom', 'right'].some(k => bf[k].type !== 'none')) {
      const sp = (v) => Math.max(0, Math.min(31, Math.round(v / 100)));
      x += '<w:pBdr>';
      if (bf.top.type !== 'none') x += borderXml('top', bf.top, sp(ps.borderTop));
      if (bf.left.type !== 'none') x += borderXml('left', bf.left, sp(ps.borderLeft));
      if (bf.bottom.type !== 'none') x += borderXml('bottom', bf.bottom, sp(ps.borderBottom));
      if (bf.right.type !== 'none') x += borderXml('right', bf.right, sp(ps.borderRight));
      x += '</w:pBdr>';
    }
    if (bf?.fill) x += `<w:shd w:val="clear" w:color="auto" w:fill="${bf.fill}"/>`;
    const td = doc.tabDefs[ps.tabDefId];
    if (td && (td.tabs.length || td.autoRight)) {
      x += '<w:tabs>';
      for (const t of td.tabs) x += `<w:tab w:val="${['left', 'right', 'center', 'decimal'][t.kind] ?? 'left'}"${t.fill ? ' w:leader="dot"' : ''} w:pos="${tw(t.pos / 2)}"/>`;
      if (td.autoRight && p.textWidth) x += `<w:tab w:val="right" w:pos="${tw(p.textWidth - ps.right)}"/>`;
      x += '</w:tabs>';
    }
    // 한글 줄 나눔 기준(글자/어절), 한글-영문 자동 간격, 줄 격자를 한글 설정대로 맞춘다
    x += '<w:kinsoku w:val="1"/>';
    x += `<w:wordWrap w:val="${ps.breakHangul === 1 ? 0 : 1}"/>`;
    x += '<w:overflowPunct w:val="0"/>';
    x += `<w:autoSpaceDE w:val="${ps.autoSpaceEn ? 1 : 0}"/><w:autoSpaceDN w:val="${ps.autoSpaceNum ? 1 : 0}"/>`;
    x += '<w:adjustRightInd w:val="0"/><w:snapToGrid w:val="0"/>';
    x += `<w:spacing w:before="${tw(p.before)}" w:after="${tw(p.after)}" w:line="${Math.max(1, tw(p.line.v))}" w:lineRule="${p.line.rule}"/>`;
    // 한글 내어쓰기: 첫 줄은 왼쪽 여백에서, 나머지 줄은 그만큼 안쪽에서 시작
    if (ps.indent < 0) x += `<w:ind w:left="${tw(ps.left - ps.indent)}" w:right="${tw(ps.right)}" w:hanging="${tw(-ps.indent)}"/>`;
    else x += `<w:ind w:left="${tw(ps.left)}" w:right="${tw(ps.right)}" w:firstLine="${tw(ps.indent)}"/>`;
    x += `<w:jc w:val="${ALIGN[ps.align] ?? 'both'}"/>`;
    x += `<w:rPr>${p.mark}</w:rPr>`;
    if (p.sectPr) x += p.sectPr;
    x += '</w:pPr>';
    return `<w:p>${x}${p.runs}</w:p>`;
  }

  const spacerXml = (hu, extra = '') =>
    `<w:p><w:pPr>${extra}<w:widowControl w:val="0"/><w:snapToGrid w:val="0"/><w:spacing w:before="0" w:after="0" w:line="${Math.max(20, tw(hu))}" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>`;

  // ── 표 ────────────────────────────────────────────────────────────
  function tableXml(t, env, place) {
    report.stats.tables++;
    const nC = t.cols, nR = t.rows;
    // 열 너비: 병합되지 않은 칸에서 먼저 구하고, 병합 칸으로 나머지를 푼다
    const colW = new Array(nC).fill(null);
    for (const c of t.cells) if (c.colSpan === 1 && c.col < nC && colW[c.col] == null) colW[c.col] = c.width;
    for (let pass = 0; pass < nC; pass++) {
      for (const c of t.cells) {
        let unknown = -1, sum = 0, n = 0;
        for (let k = c.col; k < c.col + c.colSpan && k < nC; k++) { if (colW[k] == null) { unknown = k; n++; } else sum += colW[k]; }
        if (n === 1) colW[unknown] = Math.max(0, c.width - sum);
      }
    }
    for (const c of t.cells) {
      const un = []; let sum = 0;
      for (let k = c.col; k < c.col + c.colSpan && k < nC; k++) { if (colW[k] == null) un.push(k); else sum += colW[k]; }
      if (un.length) for (const k of un) colW[k] = Math.max(0, (c.width - sum) / un.length);
    }
    for (let k = 0; k < nC; k++) if (colW[k] == null) colW[k] = 0;
    const colTw = colW.map(tw);
    const grid = Array.from({ length: nR }, () => new Array(nC).fill(null));
    for (const c of t.cells) for (let r = c.row; r < c.row + c.rowSpan && r < nR; r++) for (let k = c.col; k < c.col + c.colSpan && k < nC; k++) grid[r][k] = c;
    const rowH = new Array(nR).fill(null);
    for (const c of t.cells) if (c.rowSpan === 1 && c.row < nR) rowH[c.row] = Math.max(rowH[c.row] ?? 0, c.height);

    const sumH = rowH.reduce((a, b) => a + (b ?? 0), 0);
    if (rowH.every(h => h != null) && t.height > 0 && sumH > t.height + 10) {
      const k = t.height / sumH;
      for (let r = 0; r < nR; r++) rowH[r] *= k;
      note('칸에 저장된 높이의 합이 표 전체 높이와 달라 표 전체 높이에 맞춰 줄 높이를 조정');
    }
    const total = colTw.reduce((a, b) => a + b, 0);
    let x = '<w:tbl><w:tblPr>';
    if (place.floating) {
      const f = place.floating;
      x += `<w:tblpPr w:leftFromText="0" w:rightFromText="0" w:topFromText="0" w:bottomFromText="0" w:vertAnchor="${f.vAnchor}" w:horzAnchor="${f.hAnchor}" w:tblpX="${tw(f.x)}" w:tblpY="${tw(f.y)}"/><w:tblOverlap w:val="overlap"/>`;
    }
    x += `<w:tblW w:w="${total}" w:type="dxa"/>`;
    if (!place.floating) {
      if (place.jc && place.jc !== 'left') x += `<w:jc w:val="${place.jc}"/>`;
    }
    if (t.cellSpacing) x += `<w:tblCellSpacing w:w="${tw(t.cellSpacing)}" w:type="dxa"/>`;
    if (!place.floating && (!place.jc || place.jc === 'left')) x += `<w:tblInd w:w="${tw(place.indent || 0)}" w:type="dxa"/>`;
    x += '<w:tblLayout w:type="fixed"/>';
    x += `<w:tblCellMar><w:top w:w="${tw(t.padTop)}" w:type="dxa"/><w:left w:w="${tw(t.padLeft)}" w:type="dxa"/><w:bottom w:w="${tw(t.padBottom)}" w:type="dxa"/><w:right w:w="${tw(t.padRight)}" w:type="dxa"/></w:tblCellMar>`;
    x += '</w:tblPr><w:tblGrid>' + colTw.map(w => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>';

    for (let r = 0; r < nR; r++) {
      let cellsXml = '', rowMar = 0, rowBorder = 0;
      for (let k = 0; k < nC;) {
        const c = grid[r][k];
        if (!c) { cellsXml += `<w:tc><w:tcPr><w:tcW w:w="${colTw[k]}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`; k++; continue; }
        const span = Math.min(c.colSpan, nC - c.col);
        const w = colTw.slice(c.col, c.col + span).reduce((a, b) => a + b, 0);
        const first = c.row === r;
        const bf = doc.borderFills[c.borderFillId - 1];
        let tc = `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>`;
        if (span > 1) tc += `<w:gridSpan w:val="${span}"/>`;
        if (c.rowSpan > 1) tc += first ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>';
        if (bf) {
          tc += '<w:tcBorders>' + borderXml('top', bf.top) + borderXml('left', bf.left) + borderXml('bottom', bf.bottom) + borderXml('right', bf.right);
          if (bf.backSlash) tc += borderXml('tl2br', bf.diagonal);
          if (bf.slash) tc += borderXml('tr2bl', bf.diagonal);
          tc += '</w:tcBorders>';
          if (bf.fill) tc += `<w:shd w:val="clear" w:color="auto" w:fill="${bf.fill}"/>`;
          if (bf.gradation) note('칸의 그러데이션 채우기는 옮기지 못함');
          if (bf.image) note('칸의 그림 채우기는 옮기지 못함');
        }
        const pad = c.ownPadding ? c : { padTop: t.padTop, padLeft: t.padLeft, padBottom: t.padBottom, padRight: t.padRight };
        let mTop = pad.padTop, mBottom = pad.padBottom;
        const hasTbl = (q) => q.items.some(i => i.t === 'ctrl' && i.ctrl.id === 'tbl ');
        const fp = c.paras[0], lp = c.paras[c.paras.length - 1];
        let cellBlocks = null;
        if (first) {
          report.stats.cells++;
          cellBlocks = convertParas(c.paras, { inCell: true, width: c.width - pad.padLeft - pad.padRight, keepNext: env.keepNext || (place.keepTogether && r < nR - 1) });
        }
        if (first && fp && lp && fp.lineSegs.length && lp.lineSegs.length && !hasTbl(fp) && !hasTbl(lp)) {
          // 한글: 줄 사이 간격이 줄 '아래'에 붙고, 칸의 마지막 줄 간격은 높이에 세지 않으며, 테두리는 자리를 차지하지 않고,
          //       글이 칸 높이 안에 들어가기만 하면 안 여백을 침범해도 줄을 키우지 않는다.
          // 워드: 고정 줄 간격은 간격이 줄 '위'에 붙고, 여백·테두리만큼 칸 안쪽이 줄어든다.
          // → 칸 안에서는 한 줄짜리 문단을 '글자 높이(+약간) 고정 + 문단 뒤 간격'으로 옮기고, 남는 차이는 칸 여백에서 덜어 낸다.
          const lastSeg = lp.lineSegs[lp.lineSegs.length - 1];
          const lps = doc.paraShapes[lp.paraShape] ?? doc.paraShapes[0];
          const contentNoGap = lastSeg.y + lastSeg.height + lps.after;
          const rendered = contentNoGap <= c.height ? c.height : contentNoGap + pad.padTop + pad.padBottom;
          const borders = bf ? (borderSz(bf.top) + borderSz(bf.bottom)) * 12.5 : 0;
          const exactParas = cellBlocks.length > 0 && cellBlocks.every(b => b.k === 'p' && b.line.rule === 'exact');
          let lead0 = fp.lineSegs[0].gap, boxes = contentNoGap + lastSeg.gap;
          if (exactParas) {
            const info = cellBlocks.map(b => {
              const N = b.line.v, t = Math.min(b.textH, N), g = N - t;
              return { t, g, lead: b.lines === 1 ? Math.min(g, 0.15 * t) : g };
            });
            cellBlocks.forEach((b, k) => {
              const f = info[k];
              if (b.lines === 1) b.line = { v: f.t + f.lead, rule: 'exact' };
              if (k < cellBlocks.length - 1) {
                let a = b.after + f.g - info[k + 1].lead;
                if (a < 0) { cellBlocks[k + 1].before = Math.max(0, cellBlocks[k + 1].before + a); a = 0; }
                b.after = a;
              }
            });
            lead0 = info[0].lead;
            boxes = cellBlocks.reduce((a, b) => a + b.before + b.after + b.lines * b.line.v, 0);
          }
          mTop = Math.max(0, pad.padTop - lead0);
          let excess = mTop + boxes + mBottom + borders - rendered;
          if (excess > 0) { const d = Math.min(mBottom, excess); mBottom -= d; excess -= d; }
          if (excess > 0) { const d = Math.min(mTop, excess); mTop -= d; excess -= d; }
          if (excess > 20) note('표의 일부 칸은 워드에서 한글보다 조금 높아질 수 있음 (줄 간격·테두리 계산 방식 차이)');
        }
        rowMar = Math.max(rowMar, mTop + mBottom);
        if (bf) rowBorder = Math.max(rowBorder, borderSz(bf.bottom) * 12.5);
        tc += `<w:tcMar><w:top w:w="${tw(mTop)}" w:type="dxa"/><w:left w:w="${tw(pad.padLeft)}" w:type="dxa"/><w:bottom w:w="${tw(mBottom)}" w:type="dxa"/><w:right w:w="${tw(pad.padRight)}" w:type="dxa"/></w:tcMar>`;
        if (c.textDir) { tc += '<w:textDirection w:val="tbRlV"/>'; note('세로쓰기 칸은 워드의 세로쓰기로 근사'); }
        tc += `<w:vAlign w:val="${['top', 'center', 'bottom'][c.valign] ?? 'top'}"/></w:tcPr>`;
        if (first) tc += blocksXml(cellBlocks, true);
        else tc += '<w:p/>';
        tc += '</w:tc>';
        cellsXml += tc; k = c.col + span;
      }
      // 워드의 '줄 높이(최소)'는 칸의 위·아래 안 여백과 가로 테두리를 뺀 안쪽 높이다 (실제 워드 출력으로 확인).
      // 한글의 칸 높이는 여백을 포함하고 테두리는 자리를 차지하지 않으므로, 그만큼 빼서 넘겨야 같은 높이가 된다.
      x += '<w:tr><w:trPr>';
      if (t.split !== 2 || place.keepTogether) x += '<w:cantSplit/>';
      if (rowH[r] != null) x += `<w:trHeight w:val="${Math.max(0, tw(rowH[r] - (opts.target === 'libreoffice' ? 0 : rowMar + rowBorder)))}" w:hRule="atLeast"/>`;
      if (t.repeatHeader && grid[r].some(c => c && c.header && c.row === r)) x += '<w:tblHeader/>';
      x += '</w:trPr>' + cellsXml + '</w:tr>';
    }
    return x + '</w:tbl>';
  }

  // ── 문단 목록 → 블록 목록 ─────────────────────────────────────────
  // 블록: {k:'p', ...} | {k:'tbl', xml} | {k:'gap', h}
  const state = { section: null, sectionStack: [], noteKind: null, lastShapes: {} };
  const notes = { footnote: [], endnote: [] };
  const noAlign = (x) => x.replace(/<w:vertAlign [^>]*\/>/g, '');
  // 각주·미주 번호 글자: 한글의 번호 모양(앞·뒤 글자)을 그대로
  const noteMark = (kind, n) => { const sh = state.lastShapes[kind] || { prefix: '', suffix: ')' }; return `${sh.prefix || ''}${n}${sh.suffix ?? ''}`; };
  // 한글 수식 → 워드 수식
  function equationXml(c, cs) {
    const sizeHu = c.size || 1000;
    const half = Math.max(2, Math.round(sizeHu / 50));
    const host = rPr(cs, 0).xml.match(/w:eastAsia="([^"]*)"/)?.[1] ?? '함초롬바탕';
    const rp = `<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math" w:eastAsia="${host}" w:cs="Cambria Math"/>${c.color && c.color !== '000000' ? `<w:color w:val="${c.color}"/>` : ''}<w:sz w:val="${half}"/><w:szCs w:val="${half}"/></w:rPr>`;
    let latex = '';
    try { latex = hwpEquationLatex(c.script || ''); } catch { latex = ''; }
    if (!latex) { note('수식 일부를 글자로 옮김'); return `<w:r>${rp}<w:t xml:space="preserve">${esc(c.script || '')}</w:t></w:r>`; }
    return latexToOmml(latex, { rPr: rp });
  }

  function headText(ps) {
    if (!ps.headType) return '';
    if (ps.headType === 3) { const b = doc.bullets[ps.numberingId - 1]; return (b?.char ?? '•') + ' '; }
    const id = ps.headType === 1 ? 0 : ps.numberingId;
    const nb = doc.numberings[ps.headType === 1 ? 0 : ps.numberingId - 1];
    if (!nb) return '';
    const lv = Math.min(ps.headLevel, 6);
    if (!numCounters.has(id)) numCounters.set(id, nb.levels.map(l => (l.start || 1) - 1));
    const cnt = numCounters.get(id);
    cnt[lv]++; for (let i = lv + 1; i < cnt.length; i++) cnt[i] = (nb.levels[i]?.start || 1) - 1;
    const fmt = nb.levels[lv]?.format ?? '';
    if (!fmt) return '';
    note('문단 번호(자동 번호)는 일반 글자로 바꿔 넣음');
    return fmt.replace(/\^(\d)/g, (_, d) => { const i = +d - 1; return formatNumber(Math.max(1, cnt[i] || 1), nb.levels[i]?.numFormat ?? 0); }) + ' ';
  }

  function convertParas(paras, env) {
    const blocks = [];
    let prevTopY = null;
    for (const para of paras) {
      report.stats.paragraphs++;
      const ps = doc.paraShapes[para.paraShape] ?? doc.paraShapes[0];
      let forceBreak = !!(para.divide & 4);
      if (!env.inCell && opts.keepPageBreaks !== false && para.lineSegs.length) {
        const y = para.lineSegs[0].y;
        if (prevTopY != null && y < prevTopY) forceBreak = true;     // 한글이 실제로 새 쪽을 시작한 자리
        const ls = para.lineSegs[para.lineSegs.length - 1];
        prevTopY = ls.y + Math.min(ls.height, 1);
      }
      if (opts.keepLineBreaks && para.lineSegs.length > 1) {
        // 한글이 실제로 줄을 바꾼 자리(파일에 저장된 배치 정보)에 줄 바꿈을 넣어 줄 나눔을 고정한다
        const cuts = para.lineSegs.slice(1).map(sg => sg.pos);
        const items = [];
        for (const it of para.items) {
          if (it.t !== 'text') { items.push(it); continue; }
          let start = 0;
          for (const cut of cuts) {
            const k = cut - it.pos;
            if (k > start && k < it.text.length) { items.push({ ...it, text: it.text.slice(start, k), pos: it.pos + start }, { t: 'br', cs: it.cs, pos: cut, soft: true }); start = k; }
            else if (k === start && k < it.text.length && items.length && items[items.length - 1].t === 'text') items.push({ t: 'br', cs: it.cs, pos: cut, soft: true });
          }
          items.push({ ...it, text: it.text.slice(start), pos: it.pos + start });
        }
        para.items = items;
      }
      const texts = [];           // 아직 문단으로 내보내지 않은 글자들
      const tables = [];
      let emittedText = false, inlinePicH = 0;
      const head = headText(ps);
      if (head) texts.push({ t: 'text', text: head, cs: para.items.find(i => i.t === 'text')?.cs ?? para.endCharShape });

      const emitPara = (extra = {}) => {
        const { xml, maxSize } = runsXml(texts);
        const endSize = markRpr(para.endCharShape).sizeHu;
        let line = lineHeightOf(para, ps, maxSize || endSize, !extra.noSegs);
        if (inlinePicH > 0 && line.rule === 'exact' && line.v < inlinePicH) line = { v: inlinePicH, rule: 'atLeast' };
        blocks.push({
          k: 'p', ps, runs: xml, mark: markRpr(texts.length ? (texts[texts.length - 1].cs ?? para.endCharShape) : para.endCharShape).xml,
          before: ps.before, after: ps.after, line, pageBreakBefore: forceBreak, textWidth: env.width,
          lines: para.lineSegs.length || 1, keepNext: !!env.keepNext, base: para.lineSegs[0]?.baseline,
          textH: para.lineSegs[0]?.height ?? (maxSize || endSize),
        });
        forceBreak = false; texts.length = 0; emittedText = true; inlinePicH = 0;
      };

      let textDone = false;
      for (const it of para.items) {
        if (it.t !== 'ctrl') { if (!textDone) texts.push(it); continue; }
        const c = it.ctrl;
        switch (c.id) {
          case 'secd': if (c.footnoteShape) state.lastShapes.footnote = c.footnoteShape; if (c.endnoteShape) state.lastShapes.endnote = c.endnoteShape; state.section = { page: c.page, defaultTab: c.defaultTab, cols: 1, colGap: 0, headers: [], footers: [], pageNum: null }; state.sectionStack.push(state.section); break;
          case 'cold': if (state.section) { state.section.cols = c.count || 1; state.section.colGap = c.gap; } break;
          case 'pgnp': if (state.section) state.section.pageNum = c; break;
          case 'head': state.section?.headers.push(c); break;
          case 'foot': state.section?.footers.push(c); break;
          case 'tbl ': tables.push(c); break;
          case 'pic ':
            if (c.data) {
              const jcP = ALIGN[ps.align] === 'center' ? 'center' : ALIGN[ps.align] === 'right' ? 'right' : 'left';
              const segP = para.lineSegs[0];
              const hostHasText = para.items.some(i => i.t === 'text' || i.t === 'tab');
              if (c.inline && !hostHasText) {
                if (forceBreak) { blocks.push({ k: 'raw', xml: spacerXml(20, '<w:pageBreakBefore/>') }); forceBreak = false; }
                blocks.push({ k: 'gap', h: ps.before + (c.marginTop || 0) });
                blocks.push({ k: 'img', xml: blockPicXml(c, { jc: jcP, indent: ps.left + (c.marginLeft || 0) }) });
                blocks.push({ k: 'gap', h: (c.marginBottom || 0) + (segP ? segP.gap : 0) + ps.after });
                emittedText = true;
              } else if (c.inline) {
                texts.push({ t: 'raw', xml: inlinePicRunXml(c) });
                inlinePicH = Math.max(inlinePicH, c.height || 0);
              } else if (c.wrap === 1 && !hostHasText) {
                const hAl = c.horzAlign === 1 ? 'center' : c.horzAlign === 2 ? 'right' : 'left';
                if (forceBreak) { blocks.push({ k: 'raw', xml: spacerXml(20, '<w:pageBreakBefore/>') }); forceBreak = false; }
                blocks.push({ k: 'gap', h: ps.before + (c.y || 0) + (c.marginTop || 0) });
                blocks.push({ k: 'img', xml: blockPicXml(c, { jc: hAl, indent: (c.x || 0) + (c.marginLeft || 0) }) });
                blocks.push({ k: 'gap', h: c.marginBottom || 0 });
                emittedText = true;
              } else {
                texts.push({ t: 'raw', xml: anchorPicRunXml(c, ps) });
              }
            }
            break;
          case 'gso ':
            if (c.data) {
              texts.push({ t: 'raw', xml: c.inline ? inlinePicRunXml(c) : anchorPicRunXml(c, ps) });
              if (c.inline) inlinePicH = Math.max(inlinePicH, c.height || 0);
            } else {
              note('그리기 개체·글상자·그림은 아직 옮기지 못함 (글상자 안의 글만 본문으로 옮김)');
              if (c.paras?.length) { if (texts.length) emitPara(); blocks.push(...convertParas(c.paras, env)); }
            }
            break;
          case 'line':
            texts.push({ t: 'raw', xml: vmlLineRunXml(c) });
            break;
          case 'rect':
            texts.push({ t: 'raw', xml: vmlRectRunXml(c) });
            break;
          case 'fn  ': case 'en  ': {
            const kind = c.id === 'fn  ' ? 'footnote' : 'endnote';
            const list = notes[kind];
            const id = list.length + 1;
            let num = id;
            for (const q of c.paras || []) for (const x of q.items) if (x.t === 'ctrl' && x.ctrl.id === 'atno' && (x.ctrl.kind === 1 || x.ctrl.kind === 2) && x.ctrl.number) num = x.ctrl.number;
            const saved = state.noteKind; state.noteKind = kind;
            const w = env.width || (state.section?.page ? state.section.page.width - state.section.page.left - state.section.page.right : 42520);
            const body = c.paras?.length ? blocksXml(convertParas(c.paras, { inCell: true, width: w }), true) : '<w:p/>';
            state.noteKind = saved;
            list.push({ id, body });
            const rp = noAlign(rPr(it.cs, 0).xml) + '<w:vertAlign w:val="superscript"/>';
            const tag = kind === 'footnote' ? 'footnoteReference' : 'endnoteReference';
            // 번호는 워드가 매기게 두고(자동 번호), 한글의 앞·뒤 글자(예: ')')만 덧붙인다
            const sh = state.lastShapes[kind] || {};
            const tx = (t) => t ? `<w:r><w:rPr>${rp}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>` : '';
            texts.push({ t: 'raw', xml: `${tx(sh.prefix)}<w:r><w:rPr>${rp}</w:rPr><w:${tag} w:id="${id}"/></w:r>${tx(sh.suffix ?? ')')}` });
            break;
          }
          case 'eqed':
            texts.push({ t: 'raw', xml: equationXml(c, it.cs) });
            inlinePicH = Math.max(inlinePicH, c.height || 0);
            break;
          case 'atno':
            if (state.noteKind && (c.kind === 1 || c.kind === 2)) {
              // 각주·미주 안의 번호: 한글처럼 '1)' 모양으로
              const sh = state.lastShapes[state.noteKind];
              const rp = noAlign(rPr(it.cs, 0).xml) + (sh?.superscript ? '<w:vertAlign w:val="superscript"/>' : '');
              const tx = (t) => t ? `<w:r><w:rPr>${rp}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>` : '';
              texts.push({ t: 'raw', xml: `${tx(sh?.prefix)}<w:r><w:rPr>${rp}</w:rPr><w:${state.noteKind}Ref/></w:r>${tx(sh?.suffix ?? ')')}` });
            } else { texts.push({ t: 'text', text: String(c.number || ''), cs: it.cs }); note('자동 번호(표·그림 번호)는 일반 숫자로 바꿔 넣음'); }
            break;
          case 'bad ': note('읽지 못한 개체 일부는 건너뜀'); break;
          default: break;      // 책갈피·계산식 등: 화면에 보이는 값은 이미 글자로 들어 있다
        }
        if (c.id !== 'tbl ') continue;
        const tblMark = blocks.length;

        const jc = ALIGN[ps.align] === 'center' ? 'center' : ALIGN[ps.align] === 'right' ? 'right' : 'left';
        const seg = para.lineSegs[0];
        if (c.inline) {
          // 글자처럼 취급: 표가 놓인 줄의 높이 = 표 높이 + 바깥 여백
          if (texts.length) { emitPara({ noSegs: true }); note('표와 글자가 한 줄에 섞인 문단은 글자와 표를 따로 배치'); }
          if (forceBreak) { blocks.push({ k: 'raw', xml: spacerXml(20, '<w:pageBreakBefore/>') }); forceBreak = false; }
          blocks.push({ k: 'gap', h: ps.before + c.marginTop });
          blocks.push({ k: 'tbl', xml: tableXml(c, env, { jc, indent: ps.left + c.marginLeft, keepTogether: true }) });
          blocks.push({ k: 'gap', h: c.marginBottom + (seg ? seg.gap : 0) + ps.after });
          emittedText = true;
        } else if (c.wrap === 1) {
          // 자리 차지: 표가 문단 위치에서 y만큼 내려온 곳에 놓이고, 글은 그 위·아래로 흐른다
          const hostHasText = para.items.some(i => i.t === 'text' || i.t === 'tab');
          const hAl = c.horzAlign === 1 ? 'center' : c.horzAlign === 2 ? 'right' : 'left';
          const firstLineH = seg ? seg.height : 0;
          if (hostHasText && c.y < firstLineH) {
            if (forceBreak) { blocks.push({ k: 'raw', xml: spacerXml(20, '<w:pageBreakBefore/>') }); forceBreak = false; }
            blocks.push({ k: 'gap', h: ps.before + c.y + c.marginTop });
            blocks.push({ k: 'tbl', xml: tableXml(c, env, { jc: hAl, indent: c.x + c.marginLeft }) });
            blocks.push({ k: 'gap', h: c.marginBottom - ps.before });
          } else if (hostHasText) {
            const pending = para.items.filter(i => i.t !== 'ctrl');
            texts.length = 0; if (head) texts.push({ t: 'text', text: head, cs: pending[0]?.cs ?? para.endCharShape });
            texts.push(...pending);
            emitPara();
            const textH = para.lineSegs.reduce((a, s) => a + s.height + s.gap, 0);
            blocks.push({ k: 'gap', h: Math.max(0, c.y + c.marginTop - textH) });
            blocks.push({ k: 'tbl', xml: tableXml(c, env, { jc: hAl, indent: c.x + c.marginLeft }) });
            blocks.push({ k: 'gap', h: c.marginBottom });
            textDone = true;   // 글자는 이미 내보냄
            texts.length = 0;
          } else {
            if (forceBreak) { blocks.push({ k: 'raw', xml: spacerXml(20, '<w:pageBreakBefore/>') }); forceBreak = false; }
            blocks.push({ k: 'gap', h: ps.before + c.y + c.marginTop });
            blocks.push({ k: 'tbl', xml: tableXml(c, env, { jc: hAl, indent: c.x + c.marginLeft }) });
            blocks.push({ k: 'gap', h: c.marginBottom });
            emittedText = true;
          }
        } else if (c.wrap === 2 || c.wrap === 3) {
          note('글 앞·뒤로 배치한 표는 워드의 글상자에 담아 같은 자리에 띄움');
          texts.push({ t: 'raw', xml: textBoxXml(c, ps, env) });
        } else {
          // 어울림 → 워드의 '떠 있는 표'
          note('어울림 배치 표는 워드의 떠 있는 표로 근사');
          const f = {
            vAnchor: c.vertRel === 0 ? 'page' : c.vertRel === 1 ? 'margin' : 'text',
            hAnchor: c.horzRel === 0 ? 'page' : c.horzRel === 1 ? 'margin' : 'text',
            x: c.x + c.marginLeft + (c.horzRel === 3 ? ps.left : 0), y: c.y + c.marginTop,
          };
          blocks.push({ k: 'tbl', xml: tableXml(c, env, { floating: f }), floating: true });
        }
        // 표 캡션: 위(2)는 표 앞에, 아래(3)·왼쪽·오른쪽은 표 뒤에 문단으로
        if (c.caption?.paras?.length) {
          const ti = blocks.findIndex((b, bi) => bi >= tblMark && b.k === 'tbl');
          if (ti >= 0) {
            const cap = convertParas(c.caption.paras, env);
            const gap = { k: 'gap', h: c.caption.gap || 0 };
            if (c.caption.pos === 2) blocks.splice(ti, 0, ...cap, gap);
            else blocks.splice(ti + 1, 0, gap, ...cap);
            if (c.caption.pos < 2) note('표 왼쪽·오른쪽 캡션은 표 아래로 옮김');
          }
        }
      }
      if (texts.length || !emittedText) emitPara();
    }
    return blocks;
  }

  let drawingId = 1, relId = 10;
  const media = [], mediaByBuf = new Map();
  function addMedia(data, ext = 'png') {
    if (!data) return null;
    if (mediaByBuf.has(data)) return mediaByBuf.get(data);
    const e = (ext || 'png').toLowerCase().replace(/^jpeg$/, 'jpg');
    const id = `rId${relId++}`;
    const target = `media/image${media.length + 1}.${e}`;
    const item = { id, ext: e, target, data };
    media.push(item); mediaByBuf.set(data, item);
    rels.push({ id, type: 'image', target, isMedia: true });
    return item;
  }
  function picGraphicXml(id, rId, cx, cy, crop) {
    const srcRect = crop && (crop.l || crop.t || crop.r || crop.b)
      ? `<a:srcRect l="${Math.round((crop.l || 0) * 100000)}" t="${Math.round((crop.t || 0) * 100000)}" r="${Math.round((crop.r || 0) * 100000)}" b="${Math.round((crop.b || 0) * 100000)}"/>`
      : '';
    return `<wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/>${srcRect}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
  }
  function inlinePicRunXml(c) {
    const m = addMedia(c.data, c.ext);
    if (!m) return '';
    const EMU = 127;
    const id = drawingId++, cx = Math.max(1270, Math.round((c.width || 2000) * EMU)), cy = Math.max(1270, Math.round((c.height || 2000) * EMU));
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${picGraphicXml(id, m.id, cx, cy, c.crop)}</wp:inline></w:drawing></w:r>`;
  }
  function anchorPicRunXml(c, ps) {
    const m = addMedia(c.data, c.ext);
    if (!m) return '';
    const EMU = 127;
    const id = drawingId++;
    const relH = ['page', 'margin', 'column', 'column'][c.horzRel] ?? 'column';
    const relV = ['page', 'margin', 'paragraph'][c.vertRel] ?? 'paragraph';
    const x = Math.round(((c.x || 0) + (c.marginLeft || 0) + (c.horzRel === 3 ? (ps?.left || 0) : 0)) * EMU);
    const y = Math.round(((c.y || 0) + (c.marginTop || 0)) * EMU);
    const cx = Math.max(1270, Math.round((c.width || 2000) * EMU)), cy = Math.max(1270, Math.round((c.height || 2000) * EMU));
    const wrapXml = c.wrap === 1 ? '<wp:wrapTopAndBottom/>' : c.wrap === 0 ? '<wp:wrapSquare wrapText="bothSides"/>' : '<wp:wrapNone/>';
    const dT = Math.max(0, Math.round((c.marginTop || 0) * EMU)), dB = Math.max(0, Math.round((c.marginBottom || 0) * EMU));
    const dL = Math.max(0, Math.round((c.marginLeft || 0) * EMU)), dR = Math.max(0, Math.round((c.marginRight || 0) * EMU));
    return `<w:r><w:drawing><wp:anchor distT="${dT}" distB="${dB}" distL="${dL}" distR="${dR}" simplePos="0" relativeHeight="${251658240 + id}" behindDoc="${c.wrap === 2 ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="${relH}"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="${relV}"><wp:posOffset>${y}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${wrapXml}${picGraphicXml(id, m.id, cx, cy, c.crop)}</wp:anchor></w:drawing></w:r>`;
  }
  function blockPicXml(c, place) {
    const ind = place.indent ? `<w:ind w:left="${tw(place.indent)}" w:right="0" w:firstLine="0"/>` : '';
    const jc = place.jc && place.jc !== 'left' ? `<w:jc w:val="${place.jc}"/>` : '';
    return `<w:p><w:pPr><w:widowControl w:val="0"/><w:snapToGrid w:val="0"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>${ind}${jc}<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr>${inlinePicRunXml(c)}</w:p>`;
  }
  function vmlLineRunXml(c) {
    const id = drawingId++;
    const x1 = ((c.x1 || 0) / 100).toFixed(2), y1 = ((c.y1 || 0) / 100).toFixed(2);
    const x2 = ((c.x2 || 0) / 100).toFixed(2), y2 = ((c.y2 || 0) / 100).toFixed(2);
    const w = Math.max(0.25, (c.w || 75) / 100).toFixed(2);
    return `<w:r><w:pict><v:line id="_x0000_s${1025 + id}" style="position:absolute;z-index:${251658240 + id};mso-position-horizontal-relative:page;mso-position-vertical-relative:page" from="${x1}pt,${y1}pt" to="${x2}pt,${y2}pt" strokecolor="#${c.color || '000000'}" strokeweight="${w}pt"/></w:pict></w:r>`;
  }
  function vmlRectRunXml(c) {
    const id = drawingId++;
    const x = ((c.x || 0) / 100).toFixed(2), y = ((c.y || 0) / 100).toFixed(2);
    const w = Math.max(1, (c.width || 1000) / 100).toFixed(2), h = Math.max(1, (c.height || 1000) / 100).toFixed(2);
    const z = c.behind === false ? 251658240 + id : -(251658240 + id);
    const st = c.stroke && c.stroke.w > 0 ? c.stroke : null;
    const strokeAttr = st ? `stroked="t" strokecolor="#${st.color || '000000'}" strokeweight="${Math.max(0.25, st.w / 100).toFixed(2)}pt"` : 'stroked="f"';
    const fillAttr = c.fill ? `filled="t" fillcolor="#${c.fill}"` : 'filled="f"';
    const tag = c.ratio > 0 ? 'v:roundrect' : 'v:rect';
    const arc = c.ratio > 0 ? ` arcsize="${(c.ratio / 100).toFixed(2)}"` : '';
    return `<w:r><w:pict><${tag} id="_x0000_s${1025 + id}"${arc} style="position:absolute;margin-left:${x}pt;margin-top:${y}pt;width:${w}pt;height:${h}pt;z-index:${z};mso-position-horizontal-relative:page;mso-position-vertical-relative:page" ${fillAttr} ${strokeAttr}/></w:pict></w:r>`;
  }
  function textBoxXml(c, ps, env) {
    const EMU = 127;       // 1 HWPUNIT = 127 EMU
    const id = drawingId++;
    const relH = ['page', 'margin', 'column', 'column'][c.horzRel] ?? 'column';
    const relV = ['page', 'margin', 'paragraph'][c.vertRel] ?? 'paragraph';
    const x = (c.x + c.marginLeft + (c.horzRel === 3 ? ps.left : 0)) * EMU, y = (c.y + c.marginTop) * EMU;
    const cx = (c.width + 20) * EMU, cy = (c.height + 150) * EMU;
    const inner = tableXml(c, { inCell: true, width: c.width }, { jc: 'left', indent: 0 }) + spacerXml(20);
    return `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251658240 + id}" behindDoc="${c.wrap === 2 ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="${relH}"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="${relV}"><wp:posOffset>${y}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="표 상자 ${id}"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx><w:txbxContent>${inner}</w:txbxContent></wps:txbx><wps:bodyPr rot="0" vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0"><a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback/></mc:AlternateContent></w:r>`;
  }

  // 글자의 세로 위치 맞추기 (실제 워드 출력으로 확인한 규칙)
  //  한글: 줄 위에서 기준선까지 = 줄배치 정보의 baseline 값(글자 크기의 0.85). 줄 사이 간격은 글자 '아래'에 붙는다.
  //  워드: 고정 줄 간격이면 줄 위에서 기준선까지 = 줄 간격의 0.8. 줄 간격이 클수록 글자가 아래로 내려간다.
  //  → 문단마다 내려가는 양 s = 0.8×줄 간격 − baseline. 첫 문단의 s만큼 위쪽 여백을 줄이고, 이웃 문단끼리 s가 다르면 그 차이를 문단 간격으로 옮긴다.
  let sectionTopShift = 0;
  function alignBaselines(out) {
    const sOf = (b) => (b.k === 'p' && b.line.rule === 'exact' && b.base != null) ? 0.8 * b.line.v - b.base : 0;
    const seq = out.filter(b => b.k === 'p' || b.k === 'tbl' || b.k === 'img');
    const paras = seq.filter(b => b.k === 'p' && b.line.rule === 'exact' && b.base != null);
    if (!paras.length) { sectionTopShift = 0; return; }
    // 위쪽 여백은 본문에서 가장 많이 쓰인 문단 모양의 s만큼 줄인다 (줄 수로 가중). 표지의 큰 제목 한 줄에 끌려가지 않게.
    const weight = new Map();
    for (const b of paras) { const k = Math.round(sOf(b) / 10) * 10; weight.set(k, (weight.get(k) || 0) + (b.runs ? b.lines : 0.2)); }
    const s0 = Math.max(0, Math.min(1500, [...weight].sort((a, b) => b[1] - a[1])[0][0]));
    sectionTopShift = s0;
    // 이웃 문단끼리 s가 다르면 차이를 문단 간격으로 옮긴다. 줄일 간격이 없으면 빚(debt)으로 넘겨 다음에 늘릴 몫에서 깎는다(위치가 한쪽으로 밀려 쌓이지 않게).
    let prevS = s0, debt = 0, prevP = null;
    for (let i = 0; i < seq.length; i++) {
      const b = seq[i];
      if (b.k === 'tbl' || b.k === 'img') {
        // 표·그림은 내려가지 않으므로, 앞 문단이 올라간 만큼 앞을 띄우고 그만큼을 뒤 문단의 간격에서 뺀다. 뺄 간격이 없으면 건드리지 않는다.
        const next = seq[i + 1];
        if (prevP && next && next.k === 'p' && !next.pageBreakBefore) {
          const pay = Math.max(0, Math.min(prevS, next.before));
          prevP.after += pay; next.before -= pay;
        }
        prevP = null; continue;
      }
      const s = sOf(b);
      let d = (b.pageBreakBefore ? s0 - s : prevS - s) + (b.pageBreakBefore ? 0 : debt);
      debt = 0;
      let nb = b.before + d;
      if (nb < 0) { if (prevP && !b.pageBreakBefore) { const t = Math.min(prevP.after, -nb); prevP.after -= t; nb += t; } debt = nb; nb = 0; }
      b.before = nb; prevP = b; prevS = s;
    }
  }

  // 표 앞뒤의 세로 간격(gap)을 이웃 문단의 간격으로 넘기거나, 넘길 곳이 없으면 높이만 가진 빈 줄로 만든다
  function blocksXml(blocks, inCell) {
    const out = [];
    let pendingGap = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.k === 'gap') { pendingGap += b.h; continue; }
      if (b.k === 'p') {
        if (pendingGap >= 10) b.before += pendingGap;
        pendingGap = 0; out.push(b);
      } else if (b.k === 'raw') { out.push(b); }
      else {   // 표 또는 블록 그림
        const prev = out[out.length - 1];
        if (prev && prev.k === 'p') { if (pendingGap >= 10) prev.after += pendingGap; }
        else if (prev && prev.k === 'tbl' && b.k === 'tbl') out.push({ k: 'raw', xml: spacerXml(pendingGap) });       // 표가 연달아 오면 워드가 하나로 합치므로 사이를 띄운다
        else if (pendingGap >= 20) out.push({ k: 'raw', xml: spacerXml(pendingGap) });
        pendingGap = 0; out.push(b);
      }
    }
    const last = out[out.length - 1];
    if (!inCell && opts.target !== 'libreoffice') alignBaselines(out);
    if (!last) out.push({ k: 'raw', xml: '<w:p/>' });
    else if (last.k === 'tbl' && (inCell || pendingGap >= 20)) out.push({ k: 'raw', xml: spacerXml(pendingGap) });
    return inCell ? out.map(b => b.k === 'p' ? pXml(b) : b.xml).join('') : out;
  }

  // ── 구역(쪽 설정, 머리말·꼬리말, 쪽 번호) ─────────────────────────
  function hfPart(kind, paras, pageNum, sec) {
    const id = `rId${relId++}`; const file = `${kind}${Object.keys(parts).length + 1}.xml`;
    let body = '';
    const width = sec.page.width - sec.page.left - sec.page.right;
    if (paras?.length) body += blocksXml(convertParas(paras, { inCell: true, width }), true);
    if (pageNum) {
      const st = doc.styles.find(s => s.name === '쪽 번호');
      const r = rPr(st?.charShape ?? 0, 1).xml;
      const d = pageNum.dash ? String.fromCharCode(pageNum.dash) : '';
      const pos = pageNum.position;
      const jc = [1, 4].includes(pos) ? 'left' : [3, 6].includes(pos) ? 'right' : 'center';
      const run = (t) => `<w:r><w:rPr>${r}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
      const fld = `<w:r><w:rPr>${r}</w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr>${r}</w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:rPr>${r}</w:rPr><w:fldChar w:fldCharType="separate"/></w:r>${run('1')}<w:r><w:rPr>${r}</w:rPr><w:fldChar w:fldCharType="end"/></w:r>`;
      body += `<w:p><w:pPr><w:snapToGrid w:val="0"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="${jc}"/></w:pPr>${d ? run(d + ' ') : ''}${fld}${d ? run(' ' + d) : ''}</w:p>`;
      if (pos > 6) note('쪽 번호의 안쪽/바깥쪽 위치는 가운데로 근사');
    }
    const root = kind === 'header' ? 'hdr' : 'ftr';
    parts[file] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${body || '<w:p/>'}</w:${root}>`;
    rels.push({ id, type: kind, target: file });
    return id;
  }

  function sectPrXml(sec) {
    const pg = sec.page ?? { width: 59528, height: 84188, left: 8504, right: 8504, top: 5668, bottom: 4252, header: 4252, footer: 4252, gutter: 0 };
    const pn = sec.pageNum && sec.pageNum.position ? sec.pageNum : null;
    const pnTop = pn && pn.position >= 1 && pn.position <= 3;
    const head = sec.headers[0], foot = sec.footers[0];
    if (sec.headers.length > 1 || sec.footers.length > 1) note('짝수/홀수 쪽 머리말·꼬리말 구분은 첫 번째 것만 옮김');
    let x = '<w:sectPr>';
    if (head || pnTop) x += `<w:headerReference w:type="default" r:id="${hfPart('header', head?.paras, pnTop ? pn : null, { page: pg })}"/>`;
    if (foot || (pn && !pnTop)) x += `<w:footerReference w:type="default" r:id="${hfPart('footer', foot?.paras, pn && !pnTop ? pn : null, { page: pg })}"/>`;
    const land = pg.landscape;
    const W = land ? pg.height : pg.width, H = land ? pg.width : pg.height;
    x += `<w:pgSz w:w="${tw(W)}" w:h="${tw(H)}"${land ? ' w:orient="landscape"' : ''}/>`;
    // 한글: 본문은 (위쪽 여백 + 머리말 여백) 아래에서 시작. 워드: 위쪽 여백 = 본문 시작, 머리말 위치는 따로.
    // 한글은 쪽의 마지막 줄에서 글자 높이만 들어가면 그 줄을 쪽에 넣지만, 워드는 줄 사이 간격까지 들어가야 넣는다.
    // 본문에서 가장 많이 쓰인 줄 사이 간격만큼 아래 여백을 줄여 쪽이 넘어가는 자리를 한글과 맞춘다.
    // 줄 사이 간격이 없는 문서도 워드의 표·줄 높이 반올림이 쌓여 마지막 빈 줄이 다음 쪽으로 넘어가는 일이 있어 최소 1mm는 여유를 둔다.
    const fit = Math.min(Math.max(sec.bodyGap || 0, 283), pg.footer);
    if (fit > 0) note(`쪽 넘김 위치를 맞추려고 아래쪽 여백을 ${(fit / 283.46).toFixed(1)}mm 줄임 (줄 간격 계산 방식 차이 보정)`);
    x += `<w:pgMar w:top="${tw(pg.top + pg.header - sectionTopShift)}" w:right="${tw(pg.right)}" w:bottom="${tw(pg.bottom + pg.footer - fit)}" w:left="${tw(pg.left + pg.gutter)}" w:header="${tw(pg.top)}" w:footer="${tw(pg.bottom)}" w:gutter="0"/>`;
    if (pn && pn.format) x += `<w:pgNumType w:fmt="${NUMFMT[pn.format] ?? 'decimal'}"/>`;
    x += sec.cols > 1 ? `<w:cols w:num="${sec.cols}" w:space="${tw(sec.colGap)}"/>` : '<w:cols w:space="0"/>';
    x += '<w:docGrid w:linePitch="360"/></w:sectPr>';
    return x;
  }

  // ── 본문 조립 ─────────────────────────────────────────────────────
  let body = '';
  doc.sections.forEach((section, si) => {
    state.section = null;
    const blocks = blocksXml(convertParas(section.paras, { inCell: false, width: 0 }), false);
    const sec = state.section ?? { headers: [], footers: [] };
    const width = sec.page ? sec.page.width - sec.page.left - sec.page.right - sec.page.gutter : 0;
    for (const b of blocks) if (b.k === 'p') b.textWidth = width;
    // 본문(표 밖) 줄들의 줄 사이 간격 중 가장 많이 쓰인 값
    const gapCount = new Map();
    for (const p of section.paras) if (!p.items.some(i => i.t === 'ctrl' && i.ctrl.id === 'tbl ')) for (const sg of p.lineSegs) gapCount.set(sg.gap, (gapCount.get(sg.gap) || 0) + 1);
    sec.bodyGap = [...gapCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const sp = sectPrXml(sec);
    const isLast = si === doc.sections.length - 1;
    if (!isLast) {
      let lastP = null; for (let i = blocks.length - 1; i >= 0; i--) { if (blocks[i].k === 'p') { lastP = blocks[i]; break; } if (blocks[i].k === 'tbl' || blocks[i].k === 'img') break; }
      if (lastP) lastP.sectPr = sp; else blocks.push({ k: 'raw', xml: `<w:p><w:pPr>${sp}</w:pPr></w:p>` });
    }
    body += blocks.map(b => b.k === 'p' ? pXml(b) : b.xml).join('');
    if (isLast) body += sp;
    if (sec.defaultTab) state.defaultTab = sec.defaultTab;
  });

  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const base = doc.styles[0] ? rPr(doc.styles[0].charShape, 0) : rPr(0, 0);
  const mediaExts = new Map();
  for (const m of media) mediaExts.set(m.ext, m.mime);
  const mediaDefaults = [...mediaExts].map(([ext, mime]) => `<Default Extension="${ext}" ContentType="${mime}"/>`).join('');
  for (const kind of ['footnote', 'endnote']) {
    const list = notes[kind];
    if (!list.length) continue;
    const root = kind + 's';
    const sepP = (t) => `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${t}/></w:r></w:p>`;
    parts[root + '.xml'] = `${XML}<w:${root} ${NS}><w:${kind} w:type="separator" w:id="-1">${sepP('separator')}</w:${kind}><w:${kind} w:type="continuationSeparator" w:id="0">${sepP('continuationSeparator')}</w:${kind}>${list.map(n => `<w:${kind} w:id="${n.id}">${n.body}</w:${kind}>`).join('')}</w:${root}>`;
    rels.push({ id: `rId${relId++}`, type: root, target: root + '.xml' });
  }
  const notePr = (notes.footnote.length ? '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>' : '') + (notes.endnote.length ? '<w:endnotePr><w:endnote w:id="-1"/><w:endnote w:id="0"/></w:endnotePr>' : '');
  const files = {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${mediaDefaults}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${rels.filter(r => !r.isMedia).map(r => `<Override PartName="/word/${r.target}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${r.type}+xml"/>`).join('')}</Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${rels.map(r => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${r.type}" Target="${r.target}"/>`).join('')}</Relationships>`,
    'word/document.xml': `${XML}<w:document ${NS}><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': `${XML}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr>${base.xml}<w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="a1"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`,
    'word/settings.xml': `${XML}<w:settings ${NS}><w:zoom w:percent="100"/><w:defaultTabStop w:val="${tw((state.defaultTab ?? 8000) / 2)}"/><w:noPunctuationKerning/><w:characterSpacingControl w:val="doNotCompress"/>${notePr}<w:compat><w:spaceForUL/><w:balanceSingleByteDoubleByteWidth/><w:doNotLeaveBackslashAlone/><w:ulTrailSpace/><w:useFELayout/><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/><w:compatSetting w:name="overrideTableStyleFontSizeAndJustification" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/><w:compatSetting w:name="enableOpenTypeFeatures" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/><w:compatSetting w:name="doNotFlipMirrorIndents" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/></w:compat></w:settings>`,
  };
  for (const [name, xml] of Object.entries(parts)) files['word/' + name] = xml;
  for (const m of media) files['word/' + m.target] = m.data;
  const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v instanceof Uint8Array ? v : strToU8(v)])), { level: 6 });
  return {
    docx: zipped,
    report: {
      stats: report.stats,
      fonts: [...report.fonts].sort(),
      approximations: [...report.approximations].map(([msg, count]) => ({ msg, count })),
    },
  };
}
