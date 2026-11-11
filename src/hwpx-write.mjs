// 워드 모델(docx-read) → 한글 HWPX 패키지
// 단위: 워드 twip(1/20 pt) × 5 = 한글 HWPUNIT(1/100 pt). 워드 글자 크기 half-point × 50 = 한글 글자 높이.
import { zipSync, strToU8 } from 'fflate';
import { HEADER_XML, VERSION_XML, CONTAINER_XML, MANIFEST_XML, SECTION_OPEN, HPF_OPEN } from './hwpx-skeleton.mjs';
import { HANGUL_ADVANCE, SPACE_ADVANCE, SPACE_ADVANCE_GUESS, LINE_HEIGHT, VMETRICS } from './font-metrics.mjs';

const H = (twip) => Math.round(twip * 5);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const LANGS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
const LANG_UP = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
const ALIGN = { left: 'LEFT', start: 'LEFT', center: 'CENTER', right: 'RIGHT', end: 'RIGHT', both: 'JUSTIFY', distribute: 'DISTRIBUTE', thaiDistribute: 'DISTRIBUTE', lowKashida: 'JUSTIFY', mediumKashida: 'JUSTIFY', highKashida: 'JUSTIFY' };
const LINE_TYPE = { single: 'SOLID', thick: 'SOLID', double: 'DOUBLE_SLIM', dotted: 'DOT', dashed: 'DASH', dashSmallGap: 'DASH', dotDash: 'DASH_DOT', dotDotDash: 'DASH_DOT_DOT', triple: 'SLIM_THICK_SLIM', thinThickSmallGap: 'THICK_SLIM', thickThinSmallGap: 'SLIM_THICK', thinThickMediumGap: 'THICK_SLIM', thickThinMediumGap: 'SLIM_THICK', thinThickThinSmallGap: 'SLIM_THICK_SLIM', wave: 'WAVE', doubleWave: 'DOUBLEWAVE', threeDEmboss: '3D', threeDEngrave: 'REV3D', outset: '3D', inset: 'REV3D' };
const WIDTHS = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
const widthStr = (sz) => {   // 워드 선 굵기(1/8 pt) → 가장 가까운 한글 굵기
  const mm = (sz / 8) * 0.3528;
  let best = WIDTHS[0]; for (const w of WIDTHS) if (Math.abs(w - mm) < Math.abs(best - mm)) best = w;
  return (Number.isInteger(best) ? best.toFixed(1) : String(best)) + ' mm';
};
const UNDERLINE = { single: 'SOLID', words: 'SOLID', double: 'DOUBLE_SLIM', thick: 'SOLID', dotted: 'DOT', dottedHeavy: 'DOT', dash: 'DASH', dashedHeavy: 'DASH', dashLong: 'LONG_DASH', dotDash: 'DASH_DOT', dotDotDash: 'DASH_DOT_DOT', wave: 'WAVE', wavyDouble: 'DOUBLEWAVE' };

// 한글이 글자를 어느 언어 글꼴로 그리는지 (한글·영문·한자·일어·외국어·기호·사용자)
function langOf(c) {
  if ((c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3130 && c <= 0x318F) || (c >= 0xA960 && c <= 0xA97F) || (c >= 0xD7B0 && c <= 0xD7FF)) return 0;
  if (c < 0x80 || (c >= 0x00C0 && c <= 0x024F)) return 1;
  if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0xF900 && c <= 0xFAFF)) return 2;
  if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x31F0 && c <= 0x31FF)) return 3;
  if ((c >= 0x80 && c <= 0xBF) || (c >= 0x2000 && c <= 0x2BFF) || (c >= 0x2E80 && c <= 0x2FDF) || (c >= 0x3000 && c <= 0x303F) || (c >= 0x3200 && c <= 0x33FF) || (c >= 0xFE30 && c <= 0xFE6F) || (c >= 0xFF00 && c <= 0xFFEF)) return 5;
  return 4;
}
const isEA = (c) => c != null && ((c >= 0x1100 && c <= 0x11FF) || c >= 0x2E80);

export function buildHwpx(model, opts = {}) {
  const notes = new Map(model.notes || []);
  const note = (m) => notes.set(m, (notes.get(m) || 0) + 1);
  const fontsUsed = new Set();

  // ── 글꼴 목록 (언어마다 같은 목록을 쓴다. 0·1번은 틀에 있던 함초롬돋움·함초롬바탕) ──
  const fontList = ['함초롬돋움', '함초롬바탕'];
  const fontId = (name) => { let i = fontList.indexOf(name); if (i < 0) { i = fontList.length; fontList.push(name); } fontsUsed.add(name); return i; };

  // ── 테두리/채우기 (틀에 1, 2번이 있다) ──
  const borderFills = []; const bfKey = new Map();
  const lineXml = (tag, b) => !b || b.type === 'none'
    ? `<hh:${tag} type="NONE" width="0.1 mm" color="#000000"/>`
    : `<hh:${tag} type="${LINE_TYPE[b.type] ?? 'SOLID'}" width="${widthStr(b.sz)}" color="#${b.color}"/>`;
  function borderFill({ left, right, top, bottom, fill, tl2br, tr2bl } = {}) {
    let x = `<hh:slash type="${tr2bl && tr2bl.type !== 'none' ? 'CENTER' : 'NONE'}" Crooked="0" isCounter="0"/><hh:backSlash type="${tl2br && tl2br.type !== 'none' ? 'CENTER' : 'NONE'}" Crooked="0" isCounter="0"/>`;
    x += lineXml('leftBorder', left) + lineXml('rightBorder', right) + lineXml('topBorder', top) + lineXml('bottomBorder', bottom);
    const diag = (tl2br && tl2br.type !== 'none') ? tl2br : tr2bl;
    x += diag && diag.type !== 'none' ? lineXml('diagonal', diag) : '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>';
    if (fill) x += `<hc:fillBrush><hc:winBrush faceColor="#${fill}" hatchColor="#999999" alpha="0"/></hc:fillBrush>`;
    if (bfKey.has(x)) return bfKey.get(x);
    const id = 3 + borderFills.length;
    borderFills.push(`<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">${x}</hh:borderFill>`);
    bfKey.set(x, id);
    return id;
  }
  const NO_BORDER = borderFill({});

  // ── 글자 모양 (틀에 0~6번) ──
  const charPrs = []; const cpKey = new Map();
  function charPr(r, spaceSpacing = null) {
    const sizePt = (r.sz ?? 20) / 2;
    const ea = r.fonts?.eastAsia || r.fonts?.ascii || '맑은 고딕';
    const la = r.fonts?.ascii || r.fonts?.hAnsi || ea;
    const ot = r.fonts?.hAnsi || la;
    const faces = [ea, la, ea, ea, ot, r.fonts?.hint === 'eastAsia' ? ea : ea, ea].map(fontId);
    const ratio = Math.max(50, Math.min(200, Math.round(r.w ?? 100)));
    let spacing = r.spacing ? Math.round((r.spacing / 20) / sizePt * 100) : 0;
    if (spaceSpacing != null) spacing = spaceSpacing;
    spacing = Math.max(-50, Math.min(50, spacing));
    let height = Math.round((r.sz ?? 20) * 50);
    const offset = r.position ? Math.max(-100, Math.min(100, Math.round((r.position / 2) / sizePt * 100))) : 0;
    const key = JSON.stringify([faces, ratio, spacing, height, offset, r.b, r.i, r.u, r.uColor, r.strike, r.dstrike, r.color, r.shade, r.vertAlign, r.outline, r.shadow, r.emboss, r.imprint]);
    if (cpKey.has(key)) return cpKey.get(key);
    const id = 7 + charPrs.length;
    const all = (v) => LANGS.map((l, i) => `${l}="${Array.isArray(v) ? v[i] : v}"`).join(' ');
    let x = `<hh:charPr id="${id}" height="${height}" textColor="#${r.color ?? '000000'}" shadeColor="${r.shade ? '#' + r.shade : 'none'}" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">`;
    x += `<hh:fontRef ${all(faces)}/><hh:ratio ${all(ratio)}/><hh:spacing ${all(spacing)}/><hh:relSz ${all(100)}/><hh:offset ${all(offset)}/>`;
    if (r.i) x += '<hh:italic/>';
    if (r.b) x += '<hh:bold/>';
    const u = r.u && r.u !== 'none' ? r.u : null;
    x += `<hh:underline type="${u ? 'BOTTOM' : 'NONE'}" shape="${u ? (UNDERLINE[u] ?? 'SOLID') : 'SOLID'}" color="#${r.uColor ?? r.color ?? '000000'}"/>`;
    x += `<hh:strikeout shape="${r.dstrike ? 'DOUBLE_SLIM' : r.strike ? 'SOLID' : 'NONE'}" color="#${r.color ?? '000000'}"/>`;
    x += `<hh:outline type="${r.outline ? 'SOLID' : 'NONE'}"/>`;
    x += `<hh:shadow type="${r.shadow ? 'DROP' : 'NONE'}" color="#C0C0C0" offsetX="10" offsetY="10"/>`;
    if (r.emboss) x += '<hh:emboss/>';
    if (r.imprint) x += '<hh:engrave/>';
    if (r.vertAlign === 'superscript') x += '<hh:supscript/>';
    else if (r.vertAlign === 'subscript') x += '<hh:subscript/>';
    x += '</hh:charPr>';
    charPrs.push(x); cpKey.set(key, id);
    return id;
  }

  // 빈칸 폭 보정 (실제 워드 출력으로 확인한 규칙)
  //  · 보통 워드 문서: 빈칸을 영문 글꼴의 빈칸 폭(맑은 고딕 0.35, 함초롬 0.3 …)으로 그린다.
  //  · '반자·전자 폭 맞춤'(balanceSingleByteDoubleByteWidth) 설정이 켜진 문서: 한글 옆 빈칸은 한글 글자 폭의 절반, 글자 간격은 두 배로 적용.
  // 한글은 빈칸을 언제나 글자 크기의 절반으로 그리므로, 차이를 그 빈칸의 자간(%)으로 맞춘다.
  // 반환값은 그 빈칸에 줄 자간(%). 한글의 자간은 빈칸에서는 '빈칸 폭(글자 크기의 절반)'에 대한 비율로 적용된다(실측: −15% → 5.04pt가 4.28pt).
  function spaceAdjust(r, kind) {
    const ea = r.fonts?.eastAsia || '맑은 고딕';
    const la = r.fonts?.ascii || r.fonts?.hAnsi || ea;
    const sizePt = (r.sz ?? 20) / 2;
    let want, extra = r.spacing ? (r.spacing / 20) : 0;   // pt
    if (r.spaceEm != null) want = r.spaceEm;   // 글꼴의 빈칸 폭을 직접 알 때 (PDF에서 읽음)
    else if (model.balanceWidth && kind === 'ea') { want = (HANGUL_ADVANCE[ea] ?? 1) / 2; extra *= 2; }
    else {
      want = SPACE_ADVANCE[la] ?? SPACE_ADVANCE_GUESS[la];
      if (want == null) { note(`글꼴 '${la}'의 띄어쓰기 폭을 몰라 빈칸 폭은 한글 기본값으로 둠`); return null; }
    }
    const wordW = want * sizePt * ((r.w ?? 100) / 100) + extra;
    const hwpBase = 0.5 * sizePt * ((r.w ?? 100) / 100);
    const pct = Math.round((wordW / hwpBase - 1) * 100);
    return pct;
  }

  // ── 탭 정의 (틀: 0 기본, 1 내어쓰기 자동 탭, 2 오른쪽 끝 자동 탭) ──
  const tabPrs = []; const tabKey = new Map();
  function tabPr(tabs, auto) {
    if (!tabs || !tabs.length) return auto ? 1 : 0;
    const items = tabs.filter(t => t.val !== 'clear' && t.val !== 'bar');
    if (!items.length) return auto ? 1 : 0;
    const TYPE = { left: 'LEFT', start: 'LEFT', right: 'RIGHT', end: 'RIGHT', center: 'CENTER', decimal: 'DECIMAL' };
    const LEAD = { dot: 'DOT', hyphen: 'DASH', underscore: 'SOLID', middleDot: 'DOT', heavy: 'SOLID' };
    let x = '';
    for (const t of items) {
      const type = TYPE[t.val] ?? 'LEFT', lead = LEAD[t.leader] ?? 'NONE';
      x += `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:tabItem pos="${H(t.pos)}" type="${type}" leader="${lead}" unit="HWPUNIT"/></hp:case><hp:default><hh:tabItem pos="${H(t.pos) * 2}" type="${type}" leader="${lead}"/></hp:default></hp:switch>`;
    }
    const key = (auto ? 1 : 0) + x;
    if (tabKey.has(key)) return tabKey.get(key);
    const id = 3 + tabPrs.length;
    tabPrs.push(`<hh:tabPr id="${id}" autoTabLeft="${auto ? 1 : 0}" autoTabRight="0">${x}</hh:tabPr>`);
    tabKey.set(key, id);
    return id;
  }

  // ── 문단 모양 (틀에 0~19번) ──
  const paraPrs = []; const ppKey = new Map();
  function paraPr(pp) {
    const key = JSON.stringify(pp);
    if (ppKey.has(key)) return ppKey.get(key);
    const id = 20 + paraPrs.length;
    const m = (name, v) => [`<hc:${name} value="${v}" unit="HWPUNIT"/>`, `<hc:${name} value="${v * 2}" unit="HWPUNIT"/>`];
    const parts = [m('intent', pp.intent), m('left', pp.left), m('right', pp.right), m('prev', pp.prev), m('next', pp.next)];
    const ls = (dbl) => `<hh:lineSpacing type="${pp.lineType}" value="${pp.lineType === 'PERCENT' || !dbl ? pp.lineValue : pp.lineValue * 2}" unit="HWPUNIT"/>`;
    let x = `<hh:paraPr id="${id}" tabPrIDRef="${pp.tab}" condense="0" fontLineHeight="0" snapToGrid="0" suppressLineNumbers="0" checked="0" textDir="LTR">`;
    x += `<hh:align horizontal="${pp.align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>`;
    x += `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="${pp.keepWord ? 'KEEP_WORD' : 'BREAK_WORD'}" widowOrphan="${pp.widow ? 1 : 0}" keepWithNext="${pp.keepNext ? 1 : 0}" keepLines="${pp.keepLines ? 1 : 0}" pageBreakBefore="${pp.pageBreakBefore ? 1 : 0}" lineWrap="BREAK"/>`;
    x += `<hh:autoSpacing eAsianEng="${pp.autoEng ? 1 : 0}" eAsianNum="${pp.autoNum ? 1 : 0}"/>`;
    x += `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:margin>${parts.map(p => p[0]).join('')}</hh:margin>${ls(false)}</hp:case><hp:default><hh:margin>${parts.map(p => p[1]).join('')}</hh:margin>${ls(true)}</hp:default></hp:switch>`;
    x += `<hh:border borderFillIDRef="${pp.border}" offsetLeft="${pp.bo[0]}" offsetRight="${pp.bo[1]}" offsetTop="${pp.bo[2]}" offsetBottom="${pp.bo[3]}" connect="${pp.connect ? 1 : 0}" ignoreMargin="0"/>`;
    x += '</hh:paraPr>';
    paraPrs.push(x); ppKey.set(key, id);
    return id;
  }

  // 워드 줄 간격 → 한글 줄 간격
  function lineSpacing(ppr, sizeHalfPt, eaFont) {
    if (ppr.hwpLine) return ppr.hwpLine;   // 한글 값을 그대로 쓰는 경우(서식 틀)
    const sp = ppr.spacing || {};
    if (sp.line == null) sp.line = 240, sp.lineRule = 'auto';
    if (sp.lineRule === 'exact') return { type: 'FIXED', value: H(sp.line) };
    if (sp.lineRule === 'atLeast') return { type: 'AT_LEAST', value: H(sp.line) };
    // 'auto': 줄 높이 = 배수 × 글꼴의 한 줄 높이. 한글의 % 줄 간격은 글자 크기에 대한 비율이므로 글꼴 줄 높이 비율을 곱해 넘긴다.
    const factor = LINE_HEIGHT[eaFont] ?? 1.2;
    if (LINE_HEIGHT[eaFont] == null) note(`글꼴 '${eaFont}'의 워드 한 줄 높이를 몰라 1.2배로 어림함`);
    return { type: 'PERCENT', value: Math.max(50, Math.round(sp.line / 240 * factor * 100)) };
  }

  // ── 문단 ──
  let pid = 0;
  const nextId = () => String(++pid);

  function runXml(cp, inner) { return `<hp:run charPrIDRef="${cp}">${inner}</hp:run>`; }

  function paraXml(b, env) {
    const pr = b.ppr;
    const firstR = b.runs.find(r => r.rpr)?.rpr ?? b.markR;
    const sizeHalf = Math.max(...b.runs.filter(r => r.t === 'text' && r.rpr).map(r => r.rpr.sz ?? 20), b.markR?.sz ?? 20);
    const ea = firstR?.fonts?.eastAsia || '맑은 고딕';
    const ind = pr.ind || {};
    const first = ind.first || 0, left = ind.left || 0;
    let hLeft = left, intent = first;
    if (first < 0) hLeft = left + first;
    const ls = lineSpacing(pr, sizeHalf, ea);
    const brd = pr.borders || {};
    const hasBorder = ['top', 'left', 'bottom', 'right'].some(e => brd[e] && brd[e].type !== 'none');
    const border = hasBorder || pr.shade ? borderFill({ left: brd.left, right: brd.right, top: brd.top, bottom: brd.bottom, fill: pr.shade }) : 2;
    const bo = hasBorder ? ['left', 'right', 'top', 'bottom'].map(e => brd[e] && brd[e].type !== 'none' ? Math.round((brd[e].space || 0) * 100) : 0) : [0, 0, 0, 0];
    const hasTab = b.runs.some(r => r.t === 'tab');
    const pp = {
      align: ALIGN[pr.jc] ?? 'LEFT', intent: H(intent), left: H(hLeft), right: H(ind.right || 0),
      prev: H(env.before ?? pr.spacing?.before ?? 0), next: H(env.after ?? pr.spacing?.after ?? 0),
      lineType: ls.type, lineValue: ls.value,
      tab: tabPr(pr.tabs, b.numbered || (hasTab && first < 0)),
      keepWord: !pr.hwpWordBreak, /* hwpWordBreak: 한글 '어절' 단위(BREAK_WORD)로 끊을 문단. */ /* 실측: 워드는 한글을 글자 단위로 끊는다. 한글은 breakNonLatinWord=KEEP_WORD일 때 글자 단위(BREAK_WORD는 어절 단위) */ widow: !!pr.widowControl, keepNext: !!pr.keepNext, keepLines: !!pr.keepLines,
      pageBreakBefore: !!pr.pageBreakBefore, autoEng: false, autoNum: false,   // 워드는 한글 문서에서 한글–영문·숫자 사이 자동 간격을 실제로 넣지 않는다(실측: 한글은 넣어서 줄이 밀림)
      border, bo, connect: hasBorder,
    };
    const ppId = paraPr(pp);

    // 글자 → run. 빈칸은 보정량이 있으면 따로 run을 만든다. 쪽 나눔(br page)에서 문단을 나눈다.
    const paras = [];
    let runs = '', pageBreak = !!env.pageBreak;
    const flushPara = () => { paras.push({ runs, pageBreak }); runs = ''; pageBreak = false; };
    let curCp = null, buf = '';
    const flush = () => { if (curCp != null && buf) runs += runXml(curCp, `<hp:t>${buf}</hp:t>`); buf = ''; };
    const put = (cp, xml) => { if (cp !== curCp) { flush(); curCp = cp; } buf += xml; };
    const items = b.runs;
    const charAt = (ri, ci, dir) => {   // 빈칸 이웃 글자 찾기 (같은 문단 안, 탭·줄바꿈에서 멈춤)
      let r = ri, c = ci + dir;
      while (r >= 0 && r < items.length) {
        const it = items[r];
        if (it.t !== 'text') return null;
        const chars = [...it.text];
        if (c < 0) { r--; if (r >= 0 && items[r].t === 'text') c = [...items[r].text].length - 1; continue; }
        if (c >= chars.length) { r++; c = 0; continue; }
        const cc = chars[c].codePointAt(0); if (cc !== 0x20) return cc;
        c += dir;
      }
      return null;
    };
    items.forEach((it, ri) => {
      if (it.t === 'page') { flush(); curCp = null; flushPara(); pageBreak = true; return; }
      if (it.t === 'tab') { put(charPr(it.rpr ?? firstR), '<hp:tab width="0" leader="0" type="1"/>'); return; }
      if (it.t === 'br') { put(charPr(it.rpr ?? firstR), '<hp:lineBreak/>'); return; }
      const r = it.rpr; const base = charPr(r);
      const chars = [...(r.caps ? it.text.toUpperCase() : it.text)];
      chars.forEach((ch, ci) => {
        const cc = ch.codePointAt(0);
        if (cc === 0x20 && opts.fixSpaces !== false) {
          const before = charAt(ri, ci, -1), after = charAt(ri, ci, 1);
          const kind = before == null || after == null || isEA(before) || isEA(after) ? 'ea' : 'latin';
          const adj = spaceAdjust(r, kind);
          put(adj != null ? charPr(r, adj) : base, ' ');
          return;
        }
        if (cc === 0x09) { put(base, '<hp:tab width="0" leader="0" type="1"/>'); return; }
        if (cc < 0x20) return;
        put(base, esc(ch));
      });
    });
    flush(); flushPara();
    const markCp = charPr(b.markR ?? firstR ?? {});
    return paras.map((p, i) => `<hp:p id="${nextId()}" paraPrIDRef="${ppId}" styleIDRef="0" pageBreak="${p.pageBreak ? 1 : 0}" columnBreak="0" merged="0">${(i === 0 ? env.lead || '' : '') + (p.runs || runXml(markCp, '<hp:t/>'))}</hp:p>`).join('');
  }

  // ── 표 ──
  function tableXml(t, env) {
    const nCols = t.grid.length;
    const colW = t.grid.map(H);
    const rows = t.rows;
    const nRows = rows.length;
    // 칸 테두리: 칸 자신의 설정 → 표 바깥/안쪽 선
    const edge = (c, r, e) => {
      if (c.borders[e]) return c.borders[e];
      const outer = e === 'top' ? r === 0 : e === 'bottom' ? r + c.rowSpan >= nRows : e === 'left' ? c.col === 0 : c.col + c.span >= nCols;
      if (outer) return t.borders[e];
      return (e === 'top' || e === 'bottom') ? t.borders.insideH : t.borders.insideV;
    };
    const rowH = rows.map(row => {
      const mar = row.cells.reduce((m, c) => Math.max(m, (c.mar.top || 0) + (c.mar.bottom || 0)), 0);
      // 워드의 줄 높이는 칸 안 여백을 뺀 높이. 한글 칸 높이는 여백을 포함한다.
      const bw = row.cells.reduce((m, c) => Math.max(m, c.borders.bottom?.type && c.borders.bottom.type !== 'none' ? c.borders.bottom.sz / 8 * 20 : (t.borders.insideH?.type && t.borders.insideH.type !== 'none' ? t.borders.insideH.sz / 8 * 20 : 0)), 0);
      return row.h ? H(row.h + mar + bw) : H(mar) + 1000;
    });
    let totalH = rowH.reduce((a, b) => a + b, 0);
    const width = colW.reduce((a, b) => a + b, 0);
    const m0 = t.cellMar;
    // 실측: CELL이면 칸 안 글줄 사이에서도 쪽을 나눈다(워드와 같음). TABLE은 표를 통째로 다음 쪽으로 넘기고 뒤 글이 앞을 채운다.
    // 한계: 세로로 합친 칸 중간에서는 한글이 나누지 못한다.
    let x = `<hp:tbl id="${nextId()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="${rows.some(r => r.header) ? 1 : 0}" rowCnt="${nRows}" colCnt="${nCols}" cellSpacing="0" borderFillIDRef="${NO_BORDER}" noAdjust="0">`;
    x += `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${totalH}" heightRelTo="ABSOLUTE" protect="0"/>`;
    // 글자처럼 취급한 표는 쪽을 넘어 나뉘지 않는다 → 문단 기준 '자리 차지' 배치로 둔다
    let tind = t.ind || 0;
    if ((model.compatMode ?? 15) < 15) tind -= (rows[0]?.cells[0]?.mar.left ?? t.cellMar.left);
    const hAlign = { center: 'CENTER', right: 'RIGHT', end: 'RIGHT' }[t.jc] ?? 'LEFT';
    x += `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="${hAlign}" vertOffset="0" horzOffset="${hAlign === 'LEFT' ? H(Math.max(0, tind)) : 0}"/>`;
    x += `<hp:outMargin left="0" right="0" top="0" bottom="${H(env.after || 0)}"/><hp:inMargin left="${H(m0.left)}" right="${H(m0.right)}" top="${H(m0.top)}" bottom="${H(m0.bottom)}"/>`;
    rows.forEach((row, r) => {
      x += '<hp:tr>';
      for (const c of row.cells) {
        if (c.covered) continue;
        const span = Math.min(c.span, nCols - c.col);
        const w = colW.slice(c.col, c.col + span).reduce((a, b) => a + b, 0);
        let h = 0; for (let q = r; q < r + c.rowSpan && q < nRows; q++) h += rowH[q];
        const bf = borderFill({ left: edge(c, r, 'left'), right: edge(c, r, 'right'), top: edge(c, r, 'top'), bottom: edge(c, r, 'bottom'), fill: c.shade, tl2br: c.borders.tl2br, tr2bl: c.borders.tr2bl });
        const va = { top: 'TOP', center: 'CENTER', bottom: 'BOTTOM' }[c.vAlign] ?? 'TOP';
        x += `<hp:tc name="" header="${row.header ? 1 : 0}" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="${bf}">`;
        x += `<hp:subList id="" textDirection="${c.textDir && /tbRl|btLr|tbV/.test(c.textDir) ? 'VERTICAL' : 'HORIZONTAL'}" lineWrap="BREAK" vertAlign="${va}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`;
        x += blocksXml(c.blocks.length ? c.blocks : [{ k: 'p', ppr: {}, runs: [], markR: {} }], { inCell: true });
        x += '</hp:subList>';
        // 워드의 칸 높이에는 아래 가로선 굵기도 들어간다(한글은 선이 자리를 차지하지 않음)
        const be = edge(c, r + c.rowSpan - 1, 'bottom');
        const bw = be && be.type !== 'none' ? Math.round((be.sz || 0) / 8 * 20) : 0;
        x += `<hp:cellAddr colAddr="${c.col}" rowAddr="${r}"/><hp:cellSpan colSpan="${span}" rowSpan="${c.rowSpan}"/><hp:cellSz width="${w}" height="${h}"/>`;
        x += `<hp:cellMargin left="${H(c.mar.left)}" right="${H(c.mar.right)}" top="${H(c.mar.top)}" bottom="${H(c.mar.bottom + cellDeficit + bw)}"/></hp:tc>`;
      }
      x += '</hp:tr>';
    });
    x += '</hp:tbl>';
    // 표를 담는 문단: 표 정렬과 들여쓰기만 갖고, 줄 간격·문단 간격은 없다.
    // 워드 2010 이전 호환 모드에서는 표 들여쓰기가 첫 칸 안 글자 위치 기준이다 → 테두리 위치로 바꾼다
    // 표를 붙든 빈 문단은 표 아래에 한 줄을 만든다 → 1pt 고정 줄로 거의 없앤다
    const holder = paraPr({ align: 'LEFT', intent: 0, left: 0, right: 0, prev: H(env.before || 0), next: 0, lineType: 'FIXED', lineValue: 100, tab: 0, keepWord: true, widow: false, keepNext: false, keepLines: false, pageBreakBefore: false, autoEng: false, autoNum: false, border: 2, bo: [0, 0, 0, 0], connect: false });
    const cp = charPr(env.markR ?? {});
    return `<hp:p id="${nextId()}" paraPrIDRef="${holder}" styleIDRef="0" pageBreak="${env.pageBreak ? 1 : 0}" columnBreak="0" merged="0">${env.lead || ''}<hp:run charPrIDRef="${cp}">${x}<hp:t/></hp:run></hp:p>`;
  }

  let cellDeficit = 0;   // twip
  // ── 블록 목록 ──
  // 글자의 세로 위치 (실제 워드 출력으로 확인한 규칙)
  //  워드 '배수' 줄 간격: 줄 높이 L 안에서 기준선 = ascent + (L − 글꼴 자연 높이)/2  (남는 높이를 위아래로 나눔)
  //  워드 '고정' 줄 간격: 기준선 = 0.8 L
  //  한글: 기준선 = 글자 크기의 0.85, 줄 사이 간격은 글자 아래에 붙는다.
  //  → 문단마다 한글 글자가 위로 뜨는 양 s(pt)를 구해, 이웃 문단과의 차이를 문단 간격으로 옮긴다.
  function baselineShift(b) {
    if (b.k !== 'p') return 0;
    // 글자 크기: 글자가 있으면 글자들 중 가장 큰 것(문단 표시의 크기는 줄 높이에 들어가지 않음), 빈 문단이면 문단 표시 크기
    const ts = b.runs.filter(r => r.t === 'text' && r.rpr && r.text.trim()).map(r => r.rpr.sz ?? 20);
    const size = (ts.length ? Math.max(...ts) : (b.markR?.sz ?? 20)) / 2;
    const ea = (b.runs.find(r => r.rpr)?.rpr ?? b.markR)?.fonts?.eastAsia || '맑은 고딕';
    const vm = VMETRICS[ea]; if (!vm) return 0;
    const sp = b.ppr.spacing || {};
    const line = sp.line ?? 240, rule = sp.lineRule || 'auto';
    const L1 = size * (LINE_HEIGHT[ea] ?? 1.2);
    let base;
    if (rule === 'exact') base = 0.8 * (line / 20);
    else {
      // 배수 줄 간격에서 늘어난 높이는 글자 아래에 붙는다 → 글자 위치는 1줄 간격일 때와 같다 (줄이면 그만큼 올라감)
      const L = rule === 'atLeast' ? Math.max(line / 20, L1) : (line / 240) * L1;
      base = vm[0] * size + (Math.min(L, L1) - vm[1] * size) / 2;
    }
    return base - 0.85 * size;
  }
  // 워드가 그 문단 마지막 줄에 쓰는 줄 높이(pt)와 글자 크기 — 한글은 칸·구역 맨 끝 줄 아래에 줄 간격을 붙이지 않으므로 그 차이를 메우는 데 쓴다
  function lastLine(b) {
    const ts = b.runs.filter(r => r.t === 'text' && r.rpr && r.text.trim()).map(r => r.rpr.sz ?? 20);
    const size = (ts.length ? Math.max(...ts) : (b.markR?.sz ?? 20)) / 2;
    const ea = (b.runs.find(r => r.rpr)?.rpr ?? b.markR)?.fonts?.eastAsia || '맑은 고딕';
    const sp = b.ppr.spacing || {}; const line = sp.line ?? 240, rule = sp.lineRule || 'auto';
    const L1 = size * (LINE_HEIGHT[ea] ?? 1.2);
    const L = rule === 'exact' ? line / 20 : rule === 'atLeast' ? Math.max(line / 20, L1) : (line / 240) * L1;
    return { L, size };
  }
  // 워드 문단 테두리는 테두리 여백(space)과 선 굵기만큼 문단을 키운다. 한글 문단 테두리는 높이에 들어가지 않으므로 문단 간격으로 옮긴다.
  const bdrExt = (b, e) => { const x = b.k === 'p' && b.ppr.borders?.[e]; return x && x.type !== 'none' ? Math.round((x.space || 0) * 20 + (x.sz || 0) / 8 * 20) : 0; };

  function blocksXml(blocks, env = {}) {
    const n = blocks.length;
    const bef = [], aft = [];
    blocks.forEach((b, i) => {
      if (b.k !== 'p') { bef[i] = 0; aft[i] = 0; return; }
      let before = b.ppr.spacing?.before ?? 0, after = b.ppr.spacing?.after ?? 0;
      const prev = blocks[i - 1], next = blocks[i + 1];
      // 같은 스타일 문단 사이 간격 없애기 (워드 '같은 스타일의 문단 사이에 공백 삽입 안 함')
      if (b.ppr.contextualSpacing && prev?.k === 'p' && prev.styleId === b.styleId) before = 0;
      if (b.ppr.contextualSpacing && next?.k === 'p' && next.styleId === b.styleId) after = 0;
      bef[i] = before; aft[i] = after;
    });
    // 문단 사이 간격: 워드는 '앞 문단 아래 간격'과 '뒷 문단 위 간격' 중 큰 값만 쓴다(실측. 'HTML 문단 자동 간격 사용 안 함' 설정이 켜진 문서는 둘을 더함).
    // 한글은 둘을 더하므로, 큰 값을 뒷 문단의 위 간격으로 몰고 앞 문단의 아래 간격은 0으로 둔다.
    if (!model.sumSpacing) {
      for (let i = 1; i < n; i++) if (blocks[i].k === 'p' && blocks[i - 1].k === 'p') { bef[i] = Math.max(bef[i], aft[i - 1]); aft[i - 1] = 0; }
    }
    // 한글 문단 테두리·배경은 문단 위·아래 간격까지 감싼다(워드는 글자 부분만) → 상자 바깥 간격은 이웃 문단(또는 표)으로 넘긴다
    const tBef = blocks.map(b => (b.k === 'tbl' ? b.before || 0 : 0)), tAft = new Array(n).fill(0);   // 표 앞 간격(표에 직접 준 값)
    const boxed = b => b?.k === 'p' && (!!b.ppr.shade || Object.values(b.ppr.borders || {}).some(x => x && x.type && x.type !== 'none'));
    for (let i = 0; i < n; i++) {
      if (!boxed(blocks[i])) continue;
      if (i > 0 && !boxed(blocks[i - 1]) && bef[i]) {
        if (blocks[i - 1].k === 'p') aft[i - 1] += bef[i]; else tAft[i - 1] += bef[i];
        bef[i] = 0;
      }
      if (i + 1 < n && !boxed(blocks[i + 1]) && aft[i]) {
        if (blocks[i + 1].k === 'p') bef[i + 1] += aft[i]; else tBef[i + 1] += aft[i];
        aft[i] = 0;
      }
    }
    for (let i = 0; i < n; i++) {
      if (blocks[i].k !== 'p') continue;
      bef[i] += bdrExt(blocks[i], 'top');
      if (i + 1 < n && blocks[i + 1].k === 'p') bef[i + 1] += bdrExt(blocks[i], 'bottom'); else aft[i] += bdrExt(blocks[i], 'bottom');
    }
    let lastS = 0;
    if (opts.alignBaselines !== false) {
      let prevS = 0, debt = 0;   // twip
      for (let i = 0; i < n; i++) {
        const s = Math.round(baselineShift(blocks[i]) * 20);
        let d = s - prevS + debt; debt = 0;
        if (blocks[i].k === 'p') {
          let nb = bef[i] + d;
          if (nb < 0 && i > 0 && blocks[i - 1].k === 'p') { const t = Math.min(aft[i - 1], -nb); aft[i - 1] -= t; nb += t; }
          if (nb < 0) { debt = nb; nb = 0; }
          bef[i] = nb;
        } else if (i > 0 && blocks[i - 1].k === 'p') {
          const na = aft[i - 1] + d;
          if (na < 0) { debt = na; aft[i - 1] = 0; } else aft[i - 1] = na;
        } else debt = d;
        prevS = s;
      }
      lastS = prevS;
    }
    // 표 다음 문단의 위 간격은 한글에서 표에 밀려 사라진다 → 표 바깥 아래 여백으로 옮긴다. 표 앞 문단의 아래 간격도 표를 붙든 문단 위 간격으로.
    for (let i = 0; i < n; i++) {
      if (blocks[i].k !== 'tbl') continue;
      if (i + 1 < n && blocks[i + 1].k === 'p') { tAft[i] += Math.max(0, bef[i + 1]); bef[i + 1] = 0; }
    }
    // 칸 안 마지막 문단: 워드는 마지막 줄도 줄 높이 전체를 쓰고, 한글은 글자 높이만 쓴다. 한글은 칸 맨 끝 문단의 아래 간격도 무시하므로
    // 모자란 높이(줄 높이 − 글자 크기 − 위로 옮긴 양 + 아래 간격)를 칸의 아래쪽 안 여백으로 보탠다(tableXml이 읽어 간다).
    if (env.inCell) {
      cellDeficit = 0;
      if (n && blocks[n - 1].k === 'p') {
        const { L, size } = lastLine(blocks[n - 1]);
        cellDeficit = opts.native ? 0 : Math.max(0, aft[n - 1] + Math.round((L - size) * 20) - lastS);   // 한글 값 그대로 모드에서는 보정하지 않는다
        aft[n - 1] = 0;
      }
    }
    let out = '';
    blocks.forEach((b, i) => {
      const lead = i === 0 ? env.lead : undefined;
      if (b.k === 'tbl') { out += tableXml(b, { lead, markR: b.markR ?? blocks[i - 1]?.markR, before: tBef[i] + Math.max(0, aft[i]), after: tAft[i], pageBreak: b.pageBreak }); return; }
      out += paraXml(b, { lead, before: bef[i], after: aft[i] });
    });
    return out;
  }

  // ── 구역 ──
  function secPrXml(pg, defaultTab) {
    const W = pg.landscape ? Math.min(pg.w, pg.h) : pg.w, Hh = pg.landscape ? Math.max(pg.w, pg.h) : pg.h;
    // 워드: 위쪽 여백 = 종이 위 → 본문, 머리말 거리 = 종이 위 → 머리말. 한글: 위쪽 여백 = 종이 위 → 머리말, 머리말 = 머리말 영역 높이.
    const top = Math.min(pg.header, pg.top), header = Math.max(0, pg.top - top);
    const bottom = Math.min(pg.footer, pg.bottom), footer = Math.max(0, pg.bottom - bottom);
    return `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="${H(pg.colGap)}" tabStop="${H(defaultTab)}" tabStopVal="${H(defaultTab) / 2}" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">`
      + '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>'
      + '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>'
      + '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>'
      + `<hp:pagePr landscape="${pg.landscape ? 'NARROWLY' : 'WIDELY'}" width="${H(W)}" height="${H(Hh)}" gutterType="LEFT_ONLY"><hp:margin header="${H(header)}" footer="${H(footer)}" gutter="${H(pg.gutter)}" left="${H(pg.left)}" right="${H(pg.right)}" top="${H(top)}" bottom="${H(bottom)}"/></hp:pagePr>`
      + '<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>'
      + '<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>'
      + ['BOTH', 'EVEN', 'ODD'].map(t => `<hp:pageBorderFill type="${t}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`).join('')
      + '</hp:secPr>'
      + `<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="${pg.cols || 1}" sameSz="1" sameGap="${H(pg.colGap)}"/></hp:ctrl>`;
  }

  const sectionFiles = model.sections.map((sec, si) => {
    const lead = `<hp:run charPrIDRef="0">${secPrXml(sec.page, model.defaultTab ?? 720)}</hp:run>`;
    const blocks = sec.blocks.length ? sec.blocks : [{ k: 'p', ppr: {}, runs: [], markR: {} }];
    return SECTION_OPEN + blocksXml(blocks, { lead }) + '</hs:sec>';
  });

  // ── 머리 정보: 틀에 목록을 덧붙인다 ──
  let header = HEADER_XML;
  const fontXml = fontList.map((f, i) => `<hh:font id="${i}" face="${esc(f)}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>`).join('');
  header = header.replace(/<hh:fontfaces itemCnt="7">[\s\S]*?<\/hh:fontfaces>/, `<hh:fontfaces itemCnt="7">${LANG_UP.map(l => `<hh:fontface lang="${l}" fontCnt="${fontList.length}">${fontXml}</hh:fontface>`).join('')}</hh:fontfaces>`);
  const append = (tag, cnt, items) => {
    header = header.replace(new RegExp(`<hh:${tag} itemCnt="(\\d+)">([\\s\\S]*?)</hh:${tag}>`), (m, n, body) => `<hh:${tag} itemCnt="${+n + items.length}">${body}${items.join('')}</hh:${tag}>`);
  };
  append('borderFills', 0, borderFills);
  append('charProperties', 0, charPrs);
  append('tabProperties', 0, tabPrs);
  append('paraProperties', 0, paraPrs);
  header = header.replace(/secCnt="\d+"/, `secCnt="${sectionFiles.length}"`);

  // ── 패키지 ──
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const secIds = sectionFiles.map((_, i) => `section${i}`);
  const hpf = HPF_OPEN + `<opf:metadata><opf:title/><opf:language>ko</opf:language><opf:meta name="creator" content="text">hwp2docx</opf:meta><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text">hwp2docx</opf:meta><opf:meta name="CreatedDate" content="text">${now}</opf:meta><opf:meta name="ModifiedDate" content="text">${now}</opf:meta><opf:meta name="date" content="text"/><opf:meta name="keyword" content="text"/></opf:metadata>`
    + `<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>${secIds.map(id => `<opf:item id="${id}" href="Contents/${id}.xml" media-type="application/xml"/>`).join('')}<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>`
    + `<opf:spine><opf:itemref idref="header" linear="yes"/>${secIds.map(id => `<opf:itemref idref="${id}" linear="yes"/>`).join('')}</opf:spine></opf:package>`;
  const rdf = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + ['header', ...secIds].map(id => { const f = `Contents/${id}.xml`, t = id === 'header' ? 'HeaderFile' : 'SectionFile'; return `<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="${f}"/></rdf:Description><rdf:Description rdf:about="${f}"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#${t}"/></rdf:Description>`; }).join('')
    + '<rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>';
  const settings = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>';
  const preview = model.sections.flatMap(s => s.blocks).filter(b => b.k === 'p').map(b => b.runs.filter(r => r.t === 'text').map(r => r.text).join('')).join('\r\n').slice(0, 1000);

  const files = {
    mimetype: [strToU8('application/hwp+zip'), { level: 0 }],
    'version.xml': strToU8(VERSION_XML),
    'Contents/header.xml': strToU8(header),
  };
  sectionFiles.forEach((s, i) => { files[`Contents/section${i}.xml`] = strToU8(s); });
  Object.assign(files, {
    'Preview/PrvText.txt': strToU8(preview),
    'settings.xml': strToU8(settings),
    'META-INF/container.rdf': strToU8(rdf),
    'Contents/content.hpf': strToU8(hpf),
    'META-INF/container.xml': strToU8(CONTAINER_XML.replace('<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>', '<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>')),
    'META-INF/manifest.xml': strToU8(MANIFEST_XML),
  });
  const hwpx = zipSync(files, { level: 6 });
  return {
    hwpx,
    report: {
      fonts: [...fontsUsed].sort(),
      stats: { paragraphs: pid, sections: sectionFiles.length },
      approximations: [...notes].map(([msg, count]) => ({ msg, count })),
    },
  };
}
