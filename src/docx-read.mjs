// 워드(DOCX) 읽기 — 스타일 상속, 번호 매기기, 표를 풀어 '실제로 적용되는 값'만 남긴 모델로 만든다.
// 단위: 길이는 twip(1/20 pt), 글자 크기는 half-point(워드 원래 단위) 그대로 둔다. 변환은 hwpx-write 에서 한다.
import { unzipSync, strFromU8 } from 'fflate';

// ── 아주 작은 XML 파서 (요소 이름·속성은 접두어를 뗀 이름으로도 찾을 수 있게) ───────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));
const local = (n) => { const i = n.indexOf(':'); return i < 0 ? n : n.slice(i + 1); };

export function parseXml(s) {
  const root = { n: '#root', a: {}, c: [] };
  const stack = [root];
  let i = 0;
  const attrRe = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) { const t = s.slice(i, lt); if (t.trim() || stack.length > 1) stack[stack.length - 1].c.push(decode(t)); }
    if (s.startsWith('<?', lt)) { i = s.indexOf('?>', lt) + 2; continue; }
    if (s.startsWith('<!--', lt)) { i = s.indexOf('-->', lt) + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); stack[stack.length - 1].c.push(s.slice(lt + 9, e)); i = e + 3; continue; }
    if (s.startsWith('<!', lt)) { i = s.indexOf('>', lt) + 1; continue; }
    if (s[lt + 1] === '/') { stack.pop(); i = s.indexOf('>', lt) + 1; continue; }
    let j = lt + 1;
    while (j < s.length && !/[\s/>]/.test(s[j])) j++;
    const el = { n: local(s.slice(lt + 1, j)), a: {}, c: [] };
    attrRe.lastIndex = j;
    let m;
    while ((m = attrRe.exec(s))) { const v = decode(m[2] ?? m[3] ?? ''); el.a[m[1]] = v; el.a[local(m[1])] ??= v; j = attrRe.lastIndex; }
    while (s[j] !== '>' && s[j] !== '/') j++;
    stack[stack.length - 1].c.push(el);
    if (s[j] === '/') { i = s.indexOf('>', j) + 1; } else { stack.push(el); i = j + 1; }
  }
  return root;
}
const kids = (el, name) => el ? el.c.filter(k => typeof k === 'object' && (!name || k.n === name)) : [];
const kid = (el, name) => el ? el.c.find(k => typeof k === 'object' && k.n === name) : undefined;
const attr = (el, name) => el?.a?.[name];
const num = (v, d) => { if (v == null || v === '') return d; const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const onOff = (el) => { if (!el) return undefined; const v = el.a.val; return !(v === '0' || v === 'false' || v === 'off' || v === 'none'); };
const textOf = (el) => el.c.map(k => typeof k === 'string' ? k : '').join('');

// ── 속성 읽기 ────────────────────────────────────────────────────────────
function readBorder(el) {
  if (!el) return undefined;
  const v = el.a.val;
  if (!v || v === 'nil' || v === 'none') return { type: 'none' };
  return { type: v, sz: num(el.a.sz, 4), color: el.a.color && el.a.color !== 'auto' ? el.a.color.toUpperCase() : '000000', space: num(el.a.space, 0) };
}
function readShd(el) {
  if (!el) return undefined;
  const f = el.a.fill;
  if (f && f !== 'auto') return f.toUpperCase();
  if (el.a.val === 'solid' && el.a.color && el.a.color !== 'auto') return el.a.color.toUpperCase();
  return undefined;
}
const HIGHLIGHT = { yellow: 'FFFF00', green: '00FF00', cyan: '00FFFF', magenta: 'FF00FF', blue: '0000FF', red: 'FF0000', darkBlue: '000080', darkCyan: '008080', darkGreen: '008000', darkMagenta: '800080', darkRed: '800000', darkYellow: '808000', darkGray: '808080', lightGray: 'C0C0C0', black: '000000', white: 'FFFFFF' };

function readRPr(el, theme) {
  const r = {};
  if (!el) return r;
  for (const k of el.c) {
    if (typeof k !== 'object') continue;
    switch (k.n) {
      case 'rFonts': {
        const f = {};
        for (const key of ['ascii', 'hAnsi', 'eastAsia', 'cs']) {
          if (k.a[key]) f[key] = k.a[key];
          else if (k.a[key + 'Theme']) { const t = themeFont(theme, k.a[key + 'Theme']); if (t) f[key] = t; }
        }
        if (k.a.hint) f.hint = k.a.hint;
        r.fonts = f; break;
      }
      case 'b': r.b = onOff(k); break;
      case 'i': r.i = onOff(k); break;
      case 'strike': r.strike = onOff(k); break;
      case 'dstrike': r.dstrike = onOff(k); break;
      case 'caps': r.caps = onOff(k); break;
      case 'vanish': r.vanish = onOff(k); break;
      case 'outline': r.outline = onOff(k); break;
      case 'shadow': r.shadow = onOff(k); break;
      case 'emboss': r.emboss = onOff(k); break;
      case 'imprint': r.imprint = onOff(k); break;
      case 'sz': r.sz = num(k.a.val, undefined); break;
      case 'color': if (k.a.val && k.a.val !== 'auto') r.color = k.a.val.toUpperCase(); else if (k.a.val === 'auto') r.color = '000000'; break;
      case 'u': r.u = k.a.val && k.a.val !== 'none' ? k.a.val : 'none'; if (k.a.color && k.a.color !== 'auto') r.uColor = k.a.color.toUpperCase(); break;
      case 'spacing': r.spacing = num(k.a.val, 0); break;
      case 'w': r.w = num(k.a.val, 100); break;
      case 'position': r.position = num(k.a.val, 0); break;
      case 'vertAlign': r.vertAlign = k.a.val; break;
      case 'highlight': if (HIGHLIGHT[k.a.val]) r.shade = HIGHLIGHT[k.a.val]; break;
      case 'shd': { const s = readShd(k); if (s) r.shade = s; break; }
      case 'rStyle': r.rStyle = k.a.val; break;
    }
  }
  return r;
}

function readPPr(el) {
  const p = {};
  if (!el) return p;
  for (const k of el.c) {
    if (typeof k !== 'object') continue;
    switch (k.n) {
      case 'pStyle': p.pStyle = k.a.val; break;
      case 'jc': p.jc = k.a.val; break;
      case 'ind': {
        const ind = {};
        if (k.a.left != null || k.a.start != null) ind.left = num(k.a.left ?? k.a.start, 0);
        if (k.a.right != null || k.a.end != null) ind.right = num(k.a.right ?? k.a.end, 0);
        if (k.a.hanging != null) ind.first = -num(k.a.hanging, 0);
        else if (k.a.firstLine != null) ind.first = num(k.a.firstLine, 0);
        p.ind = ind; break;
      }
      case 'spacing': {
        const s = {};
        if (k.a.before != null) s.before = num(k.a.before, 0);
        if (k.a.after != null) s.after = num(k.a.after, 0);
        if (k.a.beforeAutospacing != null && onOff({ a: { val: k.a.beforeAutospacing } })) s.before = 280;
        if (k.a.afterAutospacing != null && onOff({ a: { val: k.a.afterAutospacing } })) s.after = 280;
        if (k.a.line != null) { s.line = num(k.a.line, 240); s.lineRule = k.a.lineRule || 'auto'; }
        p.spacing = s; break;
      }
      case 'keepNext': p.keepNext = onOff(k); break;
      case 'keepLines': p.keepLines = onOff(k); break;
      case 'pageBreakBefore': p.pageBreakBefore = onOff(k); break;
      case 'widowControl': p.widowControl = onOff(k); break;
      case 'contextualSpacing': p.contextualSpacing = onOff(k); break;
      case 'numPr': {
        const ilvl = kid(k, 'ilvl'), numId = kid(k, 'numId');
        p.numPr = { ilvl: num(ilvl?.a.val, 0), numId: numId?.a.val };
        break;
      }
      case 'pBdr': {
        const b = {};
        for (const e of ['top', 'left', 'bottom', 'right', 'between']) { const x = readBorder(kid(k, e)); if (x) b[e] = x; }
        p.borders = b; break;
      }
      case 'shd': { const s = readShd(k); if (s) p.shade = s; break; }
      case 'tabs': p.tabs = kids(k, 'tab').map(t => ({ val: t.a.val, pos: num(t.a.pos, 0), leader: t.a.leader })); break;
      case 'outlineLvl': p.outlineLvl = num(k.a.val, 9); break;
      case 'wordWrap': p.wordWrap = onOff(k); break;
      case 'autoSpaceDE': p.autoSpaceDE = onOff(k); break;
      case 'autoSpaceDN': p.autoSpaceDN = onOff(k); break;
      case 'rPr': p.markRPr = k; break;
      case 'sectPr': p.sectPr = k; break;
    }
  }
  return p;
}

function mergeRPr(...list) {
  const r = {};
  for (const x of list) {
    if (!x) continue;
    for (const [k, v] of Object.entries(x)) {
      if (v === undefined) continue;
      if (k === 'fonts') r.fonts = { ...(r.fonts || {}), ...v };
      else r[k] = v;
    }
  }
  return r;
}
function mergePPr(...list) {
  const p = {};
  for (const x of list) {
    if (!x) continue;
    for (const [k, v] of Object.entries(x)) {
      if (v === undefined) continue;
      if (k === 'ind' || k === 'spacing' || k === 'borders') p[k] = { ...(p[k] || {}), ...v };
      else p[k] = v;
    }
  }
  return p;
}

// ── 테마 글꼴 ─────────────────────────────────────────────────────────
function readTheme(xml) {
  if (!xml) return null;
  const root = parseXml(xml);
  const find = (el, name) => { if (typeof el !== 'object') return null; if (el.n === name) return el; for (const k of el.c) { const r = find(k, name); if (r) return r; } return null; };
  const fontsOf = (el) => {
    if (!el) return {};
    const latin = kid(el, 'latin')?.a.typeface;
    let ea = kid(el, 'ea')?.a.typeface;
    if (!ea) ea = kids(el, 'font').find(f => f.a.script === 'Hang')?.a.typeface;
    return { latin, ea };
  };
  return { major: fontsOf(find(root, 'majorFont')), minor: fontsOf(find(root, 'minorFont')) };
}
function themeFont(theme, name) {
  if (!theme) return undefined;
  const g = name.startsWith('major') ? theme.major : theme.minor;
  return /EastAsia/.test(name) ? (g.ea || g.latin) : (g.latin || g.ea);
}

// ── 번호 매기기 ───────────────────────────────────────────────────────
function readNumbering(xml, theme) {
  const abs = {}, nums = {};
  if (!xml) return { abs, nums };
  const root = kid(parseXml(xml), 'numbering');
  for (const a of kids(root, 'abstractNum')) {
    const levels = {};
    for (const l of kids(a, 'lvl')) {
      levels[num(l.a.ilvl, 0)] = {
        start: num(kid(l, 'start')?.a.val, 1),
        fmt: kid(l, 'numFmt')?.a.val ?? 'decimal',
        text: kid(l, 'lvlText')?.a.val ?? '',
        suff: kid(l, 'suff')?.a.val ?? 'tab',
        jc: kid(l, 'lvlJc')?.a.val,
        ppr: readPPr(kid(l, 'pPr')),
        rpr: readRPr(kid(l, 'rPr'), theme),
      };
    }
    abs[a.a.abstractNumId] = levels;
  }
  for (const n of kids(root, 'num')) {
    const over = {};
    for (const o of kids(n, 'lvlOverride')) {
      const so = kid(o, 'startOverride');
      over[num(o.a.ilvl, 0)] = { start: so ? num(so.a.val, 1) : undefined, lvl: kid(o, 'lvl') };
    }
    nums[n.a.numId] = { abs: kid(n, 'abstractNumId')?.a.val, over };
  }
  return { abs, nums };
}

const ROMAN = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
function fmtNumber(n, fmt) {
  switch (fmt) {
    case 'decimal': case 'decimalHalfWidth': return String(n);
    case 'decimalZero': return n < 10 ? '0' + n : String(n);
    case 'upperRoman': case 'lowerRoman': { let s = '', v = n; for (const [k, r] of ROMAN) while (v >= k) { s += r; v -= k; } return fmt === 'lowerRoman' ? s.toLowerCase() : s; }
    case 'upperLetter': return String.fromCharCode(65 + (n - 1) % 26).repeat(Math.floor((n - 1) / 26) + 1);
    case 'lowerLetter': return String.fromCharCode(97 + (n - 1) % 26).repeat(Math.floor((n - 1) / 26) + 1);
    case 'decimalEnclosedCircle': case 'decimalEnclosedCircleChinese': return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n);
    case 'ganada': return '가나다라마바사아자차카타파하'[(n - 1) % 14];
    case 'chosung': return 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ'[(n - 1) % 14];
    case 'koreanDigital': case 'koreanCounting': case 'koreanLegal': case 'koreanDigital2': return String(n);
    case 'none': return '';
    default: return String(n);
  }
}
// 기호 글꼴(Symbol, Wingdings)의 사용자 영역 글자를 일반 유니코드 기호로
const SYMBOL_MAP = { 0xF0B7: '•', 0xF0A7: '▪', 0xF06E: '■', 0xF071: '❑', 0xF075: '◆', 0xF076: '❖', 0xF0D8: '➢', 0xF0FC: '✓', 0xF0A8: '◆', 0xF0FB: '✗', 0xF0E0: '➔', 0xF0A1: '○', 0xF06C: '●', 0xF0B2: '◇', 0xF034: '✔' };
function bulletText(s, font) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0xF000 && c <= 0xF0FF) out += SYMBOL_MAP[c] ?? '•';
    else if (/^(Symbol|Wingdings)/i.test(font || '') && c < 0x100) out += SYMBOL_MAP[0xF000 + c] ?? '•';
    else out += ch;
  }
  return out;
}

// ── 본문 ──────────────────────────────────────────────────────────────
export function readDocx(bytes) {
  const files = unzipSync(bytes);
  const get = (p) => files[p] ? strFromU8(files[p]) : null;
  const docXml = get('word/document.xml');
  if (!docXml) throw new Error('워드 문서(word/document.xml)를 찾지 못했습니다');
  const rels = {};
  const relXml = get('word/_rels/document.xml.rels');
  if (relXml) for (const r of kids(kid(parseXml(relXml), 'Relationships'), 'Relationship')) rels[r.a.Id] = r.a.Target;
  const themePath = Object.values(rels).find(t => /theme/.test(t));
  const theme = readTheme(themePath ? get('word/' + themePath.replace(/^\/?word\//, '')) : get('word/theme/theme1.xml'));
  const numbering = readNumbering(get('word/numbering.xml'), theme);
  const notes = new Map();

  // 스타일
  const styles = {}; let defaults = { rpr: {}, ppr: {} }; let defaultPStyle = null, defaultTStyle = null;
  const stylesXml = get('word/styles.xml');
  if (stylesXml) {
    const root = kid(parseXml(stylesXml), 'styles');
    const dd = kid(root, 'docDefaults');
    defaults = { rpr: readRPr(kid(kid(dd, 'rPrDefault'), 'rPr'), theme), ppr: readPPr(kid(kid(dd, 'pPrDefault'), 'pPr')) };
    for (const s of kids(root, 'style')) {
      const st = {
        type: s.a.type, id: s.a.styleId, name: kid(s, 'name')?.a.val, basedOn: kid(s, 'basedOn')?.a.val,
        ppr: readPPr(kid(s, 'pPr')), rpr: readRPr(kid(s, 'rPr'), theme),
        tblPr: kid(s, 'tblPr'), tcPr: kid(s, 'tcPr'),
        cond: Object.fromEntries(kids(s, 'tblStylePr').map(c => [c.a.type, { ppr: readPPr(kid(c, 'pPr')), rpr: readRPr(kid(c, 'rPr'), theme), tcPr: kid(c, 'tcPr') }])),
      };
      styles[st.id] = st;
      if (s.a.default === '1' || s.a.default === 'true') { if (st.type === 'paragraph') defaultPStyle = st.id; if (st.type === 'table') defaultTStyle = st.id; }
    }
  }
  const chain = (id, seen = new Set()) => { const s = styles[id]; if (!s || seen.has(id)) return []; seen.add(id); return [...chain(s.basedOn, seen), s]; };
  const styleRPr = (id) => mergeRPr(...chain(id).map(s => s.rpr));
  const stylePPr = (id) => mergePPr(...chain(id).map(s => s.ppr));

  // 문서 기본값: 글꼴 크기 10pt, 글꼴은 테마 본문 글꼴 → 없으면 맑은 고딕
  const baseFonts = { ascii: themeFont(theme, 'minorHAnsi') || 'Times New Roman', hAnsi: themeFont(theme, 'minorHAnsi') || 'Times New Roman', eastAsia: themeFont(theme, 'minorEastAsia') || '맑은 고딕' };
  const baseR = mergeRPr({ fonts: baseFonts, sz: 20, color: '000000' }, defaults.rpr);

  const counters = {};   // numId → [lvl counts]
  const report = { notes: [] };
  const note = (m) => { notes.set(m, (notes.get(m) || 0) + 1); };

  function numberText(ppr, firstRPr) {
    const np = ppr.numPr; if (!np || !np.numId || np.numId === '0') return null;
    const n = numbering.nums[np.numId]; if (!n) return null;
    const levels = numbering.abs[n.abs]; if (!levels) return null;
    const ilvl = np.ilvl || 0; const lvl = levels[ilvl]; if (!lvl) return null;
    const absKey = n.abs;   // 같은 추상 번호를 공유하는 목록은 이어서 센다 (워드 동작)
    const cnt = counters[absKey] ??= { vals: [], started: {} };
    for (let k = 0; k <= 8; k++) {
      const L = levels[k]; if (!L) continue;
      const start = n.over[k]?.start ?? L.start;
      if (k === ilvl) cnt.vals[k] = cnt.vals[k] == null ? start : cnt.vals[k] + 1;
      else if (k > ilvl) cnt.vals[k] = undefined;
      else if (cnt.vals[k] == null) cnt.vals[k] = start;
    }
    let text = lvl.text.replace(/%(\d)/g, (_, d) => { const k = +d - 1; const L = levels[k]; return L ? fmtNumber(cnt.vals[k] ?? L.start, k === ilvl ? lvl.fmt : L.fmt) : ''; });
    if (lvl.fmt === 'bullet') text = bulletText(lvl.text, lvl.rpr.fonts?.ascii);
    const rpr = mergeRPr(firstRPr, lvl.rpr);
    if (rpr.fonts && /^(Symbol|Wingdings|Webdings)/i.test(rpr.fonts.ascii || '')) rpr.fonts = { ...firstRPr.fonts };
    return { text, suff: lvl.suff, rpr, ppr: lvl.ppr, jc: lvl.jc };
  }

  // 문단 → 모델
  function readPara(p, ctx) {
    const direct = readPPr(kid(p, 'pPr'));
    const sid = direct.pStyle || defaultPStyle;
    let ppr = mergePPr(defaults.ppr, ctx.tblPPr, stylePPr(sid));
    // 번호: 스타일에서 오거나 문단에 직접
    const numPr = direct.numPr ?? ppr.numPr;
    if (numPr) {
      const n = numbering.nums[numPr.numId]; const lvl = n && numbering.abs[n.abs]?.[numPr.ilvl || 0];
      if (lvl) ppr = mergePPr(ppr, lvl.ppr);
    }
    ppr = mergePPr(ppr, direct, { numPr });
    const paraR = mergeRPr(baseR, ctx.tblRPr, styleRPr(sid));
    const runs = [];
    let pageBreakAfter = false;
    const pushText = (text, rpr) => { if (!text) return; const last = runs[runs.length - 1]; if (last && last.t === 'text' && last.rpr === rpr) last.text += text; else runs.push({ t: 'text', text, rpr }); };
    let fieldDepth = 0, fieldShow = [];
    const walkRun = (r) => {
      const d = readRPr(kid(r, 'rPr'), theme);
      const rpr = mergeRPr(paraR, d.rStyle ? styleRPr(d.rStyle) : null, d);
      if (rpr.vanish) return;
      for (const k of r.c) {
        if (typeof k !== 'object') continue;
        if (k.n === 'fldChar') {
          const t = k.a.fldCharType;
          if (t === 'begin') { fieldDepth++; fieldShow.push(false); }
          else if (t === 'separate') { fieldShow[fieldShow.length - 1] = true; }
          else if (t === 'end') { fieldDepth--; fieldShow.pop(); }
          continue;
        }
        if (fieldDepth > 0 && !fieldShow[fieldShow.length - 1]) continue;   // 필드 명령어 부분은 건너뜀
        switch (k.n) {
          case 't': pushText(textOf(k), rpr); break;
          case 'tab': runs.push({ t: 'tab', rpr }); break;
          case 'br': if (k.a.type === 'page') { runs.push({ t: 'page' }); } else if (k.a.type === 'column') runs.push({ t: 'page' }); else runs.push({ t: 'br', rpr }); break;
          case 'cr': runs.push({ t: 'br', rpr }); break;
          case 'noBreakHyphen': pushText('‑', rpr); break;
          case 'softHyphen': break;
          case 'sym': { const c = parseInt(k.a.char, 16); pushText(bulletText(String.fromCharCode(c >= 0xF000 ? c : 0xF000 + c), k.a.font), rpr); break; }
          case 'drawing': case 'pict': {
            const findDeep = (node, name) => {
              if (typeof node !== 'object') return null;
              if (node.n === name) return node;
              for (const ch of node.c || []) { const res = findDeep(ch, name); if (res) return res; }
              return null;
            };
            const blip = findDeep(k, 'blip');
            const rId = blip?.a?.['r:embed'] || blip?.a?.embed;
            const target = rId ? rels[rId] : null;
            const ext = target ? target.split('.').pop().toLowerCase() : 'png';
            const mediaPath = target ? (target.startsWith('/') ? target.slice(1) : target.startsWith('word/') ? target : `word/${target}`) : null;
            const data = mediaPath ? files[mediaPath] : null;
            if (data) {
              const extent = findDeep(k, 'extent');
              const EMU_PER_TWIP = 635; // 1 twip = 635 EMU
              const w = extent?.a?.cx ? Math.round(num(extent.a.cx, 0) / EMU_PER_TWIP) : 2880;
              const h = extent?.a?.cy ? Math.round(num(extent.a.cy, 0) / EMU_PER_TWIP) : 2880;
              runs.push({ t: 'img', data, ext, w, h, inline: true, rpr });
            } else {
              note('그림·도형은 아직 옮기지 못함');
            }
            break;
          }
          case 'object': note('그림·도형은 아직 옮기지 못함'); break;
          case 'footnoteReference': case 'endnoteReference': note('각주·미주는 아직 옮기지 못함'); break;
          case 'lastRenderedPageBreak': break;
        }
      }
    };
    const walk = (el) => {
      for (const k of el.c) {
        if (typeof k !== 'object') continue;
        if (k.n === 'r') walkRun(k);
        else if (k.n === 'hyperlink' || k.n === 'smartTag' || k.n === 'ins' || k.n === 'customXml' || k.n === 'sdt' || k.n === 'sdtContent' || k.n === 'fldSimple') walk(k);
        else if (k.n === 'del' || k.n === 'moveFrom') { /* 지운 글자 */ }
      }
    };
    walk(p);
    const markR = mergeRPr(paraR, readRPr(ppr.markRPr, theme));
    const firstR = runs.find(r => r.rpr)?.rpr ?? markR;
    const nb = numberText(ppr, firstR);
    if (nb) {
      const head = [{ t: 'text', text: nb.text, rpr: nb.rpr }];
      if (nb.suff === 'tab') head.push({ t: 'tab', rpr: nb.rpr, numTab: true });
      else if (nb.suff === 'space') head.push({ t: 'text', text: ' ', rpr: nb.rpr });
      runs.unshift(...head);
      note('워드 자동 번호는 일반 글자로 바꿔 넣음');
    }
    return { k: 'p', ppr, runs, markR, styleId: sid, numbered: !!nb, sectPr: ppr.sectPr };
  }

  // 표 → 모델
  function readTable(t, ctx) {
    const tp = kid(t, 'tblPr');
    const sid = kid(tp, 'tblStyle')?.a.val || defaultTStyle;
    const stChain = chain(sid);
    const tblPrs = [...stChain.map(s => s.tblPr), tp].filter(Boolean);
    const pick = (name) => { let v; for (const x of tblPrs) { const e = kid(x, name); if (e) v = e; } return v; };
    const borders = {};
    for (const x of tblPrs) { const b = kid(x, 'tblBorders'); if (b) for (const e of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV', 'start', 'end']) { const r = readBorder(kid(b, e)); if (r) borders[e === 'start' ? 'left' : e === 'end' ? 'right' : e] = r; } }
    const cellMar = { top: 0, left: 108, bottom: 0, right: 108 };
    for (const x of tblPrs) { const m = kid(x, 'tblCellMar'); if (m) for (const e of ['top', 'left', 'bottom', 'right', 'start', 'end']) { const v = kid(m, e); if (v) cellMar[e === 'start' ? 'left' : e === 'end' ? 'right' : e] = num(v.a.w, 0); } }
    const jc = pick('jc')?.a.val;
    const ind = pick('tblInd'); const indV = ind && ind.a.type !== 'pct' ? num(ind.a.w, 0) : 0;
    const grid = kids(kid(t, 'tblGrid'), 'gridCol').map(g => num(g.a.w, 0));
    const look = kid(tp, 'tblLook');
    const lookFirstRow = look ? (look.a.firstRow === '1' || (look.a.val && (parseInt(look.a.val, 16) & 0x20))) : true;
    const styleTcPr = stChain.map(s => s.tcPr).filter(Boolean);
    const stylePPr2 = mergePPr(...stChain.map(s => s.ppr));
    const styleRPr2 = mergeRPr(...stChain.map(s => s.rpr));
    const firstRowCond = lookFirstRow ? stChain.map(s => s.cond?.firstRow).filter(Boolean) : [];

    const rows = [];
    for (const tr of kids(t, 'tr')) {
      const trPr = kid(tr, 'trPr');
      const h = kid(trPr, 'trHeight');
      const gridBefore = num(kid(trPr, 'gridBefore')?.a.val, 0);
      const isHeader = !!kid(trPr, 'tblHeader');
      const rowIdx = rows.length;
      const cond = rowIdx === 0 ? firstRowCond : [];
      const row = { h: h ? num(h.a.val, 0) : 0, hRule: h?.a.hRule || 'atLeast', header: isHeader, cells: [], cantSplit: !!kid(trPr, 'cantSplit') };
      let col = gridBefore;
      for (const tc of kids(tr, 'tc')) {
        const pr = kid(tc, 'tcPr');
        const span = num(kid(pr, 'gridSpan')?.a.val, 1);
        const vm = kid(pr, 'vMerge');
        const cb = {};
        for (const src of [...styleTcPr, ...cond.map(c => c.tcPr).filter(Boolean), pr]) { const b = kid(src, 'tcBorders'); if (b) for (const e of ['top', 'left', 'bottom', 'right', 'start', 'end', 'tl2br', 'tr2bl']) { const r = readBorder(kid(b, e)); if (r) cb[e === 'start' ? 'left' : e === 'end' ? 'right' : e] = r; } }
        let shade; for (const src of [...styleTcPr, ...cond.map(c => c.tcPr).filter(Boolean), pr]) { const s = readShd(kid(src, 'shd')); if (s) shade = s; }
        const mar = { ...cellMar }; const m = kid(pr, 'tcMar');
        if (m) for (const e of ['top', 'left', 'bottom', 'right', 'start', 'end']) { const v = kid(m, e); if (v) mar[e === 'start' ? 'left' : e === 'end' ? 'right' : e] = num(v.a.w, 0); }
        const cctx = { tblPPr: mergePPr(stylePPr2, ...cond.map(c => c.ppr)), tblRPr: mergeRPr(styleRPr2, ...cond.map(c => c.rpr)), depth: (ctx.depth || 0) + 1 };
        row.cells.push({
          col, span, vMerge: vm ? (vm.a.val === 'restart' ? 'restart' : 'cont') : null,
          borders: cb, shade, mar, vAlign: kid(pr, 'vAlign')?.a.val || 'top',
          w: kid(pr, 'tcW') && kid(pr, 'tcW').a.type !== 'pct' ? num(kid(pr, 'tcW').a.w, 0) : 0,
          textDir: kid(pr, 'textDirection')?.a.val,
          blocks: readBlocks(tc, cctx),
        });
        col += span;
      }
      rows.push(row);
    }
    // 열 너비: tblGrid가 없거나 모자라면 칸 너비로 채운다
    const nCols = Math.max(grid.length, ...rows.map(r => r.cells.reduce((m, c) => Math.max(m, c.col + c.span), 0)));
    for (let k = 0; k < nCols; k++) if (!grid[k]) {
      const c = rows.flatMap(r => r.cells).find(c => c.col === k && c.span === 1 && c.w);
      grid[k] = c ? c.w : 1000;
    }
    // 세로 병합: restart 칸에 rowSpan을 세고 이어지는 칸은 표시
    for (let r = 0; r < rows.length; r++) for (const c of rows[r].cells) {
      c.rowSpan = 1;
      if (c.vMerge === 'restart') {
        for (let q = r + 1; q < rows.length; q++) { const d = rows[q].cells.find(x => x.col === c.col); if (d && d.vMerge === 'cont') { c.rowSpan++; d.covered = true; } else break; }
      } else if (c.vMerge === 'cont' && !c.covered) c.vMerge = null;
    }
    return { k: 'tbl', grid: grid.slice(0, nCols), rows, borders, cellMar, jc, ind: indV, styleId: sid };
  }

  function readBlocks(container, ctx = {}) {
    const out = [];
    for (const k of container.c) {
      if (typeof k !== 'object') continue;
      if (k.n === 'p') out.push(readPara(k, ctx));
      else if (k.n === 'tbl') out.push(readTable(k, ctx));
      else if (k.n === 'sdt') { const c = kid(k, 'sdtContent'); if (c) out.push(...readBlocks(c, ctx)); }
      else if (k.n === 'customXml' || k.n === 'ins') out.push(...readBlocks(k, ctx));
    }
    return out;
  }

  const body = kid(kid(parseXml(docXml), 'document'), 'body');
  const blocks = readBlocks(body);

  // 구역: 문단 안의 sectPr은 그 문단까지를 한 구역으로 끝낸다. 몸통 끝의 sectPr이 마지막 구역.
  const readSect = (s) => {
    const sz = kid(s, 'pgSz'), mg = kid(s, 'pgMar'), cols = kid(s, 'cols');
    if (kid(s, 'headerReference') || kid(s, 'footerReference')) note('머리말·꼬리말은 아직 옮기지 못함');
    return {
      w: num(sz?.a.w, 11906), h: num(sz?.a.h, 16838), landscape: sz?.a.orient === 'landscape',
      top: num(mg?.a.top, 1440), bottom: num(mg?.a.bottom, 1440), left: num(mg?.a.left, 1800), right: num(mg?.a.right, 1800),
      header: num(mg?.a.header, 851), footer: num(mg?.a.footer, 992), gutter: num(mg?.a.gutter, 0),
      cols: num(cols?.a.num, 1), colGap: num(cols?.a.space, 425),
      grid: kid(s, 'docGrid') ? { type: kid(s, 'docGrid').a.type, pitch: num(kid(s, 'docGrid').a.linePitch, 0) } : null,
    };
  };
  const sections = [];
  let cur = [];
  for (const b of blocks) {
    cur.push(b);
    if (b.k === 'p' && b.sectPr) { sections.push({ page: readSect(b.sectPr), blocks: cur }); cur = []; }
  }
  sections.push({ page: readSect(kid(body, 'sectPr')), blocks: cur });
  if (sections.length > 1 && !sections[sections.length - 1].blocks.length) sections.pop();
  if (sections.some(s => s.page.grid?.type === 'lines' || s.page.grid?.type === 'linesAndChars')) note('워드의 줄 격자(문서 격자) 설정은 옮기지 않음 — 줄 간격이 조금 다를 수 있음');

  let defaultTab = 720;
  const settingsXml = get('word/settings.xml');
  let balanceWidth = false, sumSpacing = false, compatMode = 12;
  if (settingsXml) {
    const st = kid(parseXml(settingsXml), 'settings'); const d = kid(st, 'defaultTabStop'); if (d) defaultTab = num(d.a.val, 720);
    balanceWidth = !!kid(kid(st, 'compat'), 'balanceSingleByteDoubleByteWidth');
    sumSpacing = !!kid(kid(st, 'compat'), 'doNotUseHTMLParagraphAutoSpacing');
    const cm = kids(kid(st, 'compat'), 'compatSetting').find(c => c.a.name === 'compatibilityMode');
    compatMode = cm ? num(cm.a.val, 12) : 12;
  }
  return { sections, notes, defaultTab, balanceWidth, sumSpacing, compatMode };
}
