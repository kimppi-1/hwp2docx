// HWP 5.0 (.hwp) 바이너리 파서
// 파일 안에 저장된 글꼴·글자 모양·문단 모양·표·용지 설정을 그대로 읽어 문서 모델로 만든다.
// 단위: HWPUNIT = 1/7200 인치 (100 = 1pt)
import CFB from 'cfb';
import { inflateSync } from 'fflate';

const TAG = {
  DOCUMENT_PROPERTIES: 16, ID_MAPPINGS: 17, BIN_DATA: 18, FACE_NAME: 19, BORDER_FILL: 20,
  CHAR_SHAPE: 21, TAB_DEF: 22, NUMBERING: 23, BULLET: 24, PARA_SHAPE: 25, STYLE: 26,
  PARA_HEADER: 66, PARA_TEXT: 67, PARA_CHAR_SHAPE: 68, PARA_LINE_SEG: 69, PARA_RANGE_TAG: 70,
  CTRL_HEADER: 71, LIST_HEADER: 72, PAGE_DEF: 73, FOOTNOTE_SHAPE: 74, PAGE_BORDER_FILL: 75,
  SHAPE_COMPONENT: 76, TABLE: 77,
};

class Reader {
  constructor(u8) { this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.p = 0; }
  get left() { return this.u8.length - this.p; }
  u8_() { const v = this.dv.getUint8(this.p); this.p += 1; return v; }
  i8() { const v = this.dv.getInt8(this.p); this.p += 1; return v; }
  u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  i16() { const v = this.dv.getInt16(this.p, true); this.p += 2; return v; }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  str() { const n = this.u16(); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16()); return s; }
  skip(n) { this.p += n; }
}

// COLORREF(0x00BBGGRR) → 'RRGGBB'. 상위 바이트가 차 있으면 '색 없음'
function color(v) {
  if ((v >>> 24) !== 0) return null;
  const r = v & 0xff, g = (v >>> 8) & 0xff, b = (v >>> 16) & 0xff;
  return [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function* records(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 0;
  while (off + 4 <= u8.length) {
    const h = dv.getUint32(off, true); off += 4;
    const tag = h & 0x3ff, level = (h >>> 10) & 0x3ff; let size = h >>> 20;
    if (size === 0xfff) { size = dv.getUint32(off, true); off += 4; }
    yield { tag, level, data: u8.subarray(off, off + size) };
    off += size;
  }
}

function recordTree(u8) {
  const root = { level: -1, children: [] };
  const stack = [root];
  for (const rec of records(u8)) {
    rec.children = [];
    while (stack[stack.length - 1].level >= rec.level) stack.pop();
    stack[stack.length - 1].children.push(rec);
    stack.push(rec);
  }
  return root.children;
}

const BORDER_WIDTH_MM = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
const BORDER_TYPE = ['none', 'solid', 'dash', 'dot', 'dashDot', 'dashDotDot', 'longDash', 'circle', 'double',
  'thinThick', 'thickThin', 'thinThickThin', 'wave', 'doubleWave', 'thick3D', 'thick3DRev', 'thin3D', 'thin3DRev'];

function parseBorder(r) {
  const type = r.u8_(), width = r.u8_(), col = r.u32();
  return { type: BORDER_TYPE[type] ?? 'solid', widthMm: BORDER_WIDTH_MM[width] ?? 0.1, color: color(col) ?? '000000' };
}

function parseDocInfo(u8, version) {
  const doc = {
    faces: [[], [], [], [], [], [], []], borderFills: [], charShapes: [], tabDefs: [], numberings: [],
    bullets: [], paraShapes: [], styles: [],
  };
  let faceCounts = null, faceSeen = 0;
  for (const rec of records(u8)) {
    const r = new Reader(rec.data);
    switch (rec.tag) {
      case TAG.ID_MAPPINGS: {
        const n = []; while (r.left >= 4) n.push(r.i32());
        faceCounts = n.slice(1, 8);
        break;
      }
      case TAG.FACE_NAME: {
        const attr = r.u8_(); const name = r.str();
        const face = { name };
        if (attr & 0x80) { face.altType = r.u8_(); face.altName = r.str(); }
        if (attr & 0x40) r.skip(10);
        if (attr & 0x20) face.defaultName = r.str();
        // 언어별(한글, 영문, 한자, 일어, 외국어, 기호, 사용자) 목록에 순서대로 배분
        let idx = faceSeen++, lang = 0;
        while (faceCounts && lang < 7 && idx >= faceCounts[lang]) { idx -= faceCounts[lang]; lang++; }
        doc.faces[Math.min(lang, 6)].push(face);
        break;
      }
      case TAG.BORDER_FILL: {
        const attr = r.u16();
        const bf = { slash: (attr >> 2) & 7, backSlash: (attr >> 5) & 7 };
        bf.left = parseBorder(r); bf.right = parseBorder(r); bf.top = parseBorder(r); bf.bottom = parseBorder(r);
        bf.diagonal = parseBorder(r);
        if (r.left >= 4) {
          const fillType = r.u32();
          if (fillType & 1) {
            bf.fill = color(r.u32()); bf.patternColor = color(r.u32()); bf.patternType = r.i32();
          }
          if (fillType & 4) bf.gradation = true;
          if (fillType & 2) bf.image = true;
        }
        doc.borderFills.push(bf);
        break;
      }
      case TAG.CHAR_SHAPE: {
        const cs = { face: [], ratio: [], spacing: [], relSize: [], offset: [] };
        for (let i = 0; i < 7; i++) cs.face.push(r.u16());
        for (let i = 0; i < 7; i++) cs.ratio.push(r.u8_());
        for (let i = 0; i < 7; i++) cs.spacing.push(r.i8());
        for (let i = 0; i < 7; i++) cs.relSize.push(r.u8_());
        for (let i = 0; i < 7; i++) cs.offset.push(r.i8());
        cs.size = r.i32();
        const a = r.u32();
        cs.italic = !!(a & 1); cs.bold = !!(a & 2);
        cs.underline = (a >> 2) & 3;          // 0 없음, 1 아래, 3 위
        cs.underlineShape = (a >> 4) & 15;
        cs.outline = (a >> 8) & 7; cs.shadow = (a >> 11) & 3;
        cs.emboss = !!(a & (1 << 13)); cs.engrave = !!(a & (1 << 14));
        cs.superscript = !!(a & (1 << 15)); cs.subscript = !!(a & (1 << 16));
        cs.strike = (a >> 18) & 7; cs.emphasis = (a >> 21) & 15;
        cs.strikeShape = (a >> 26) & 15; cs.kerning = !!(a & (1 << 30));
        r.skip(2);
        cs.color = color(r.u32()) ?? '000000';
        cs.underlineColor = color(r.u32());
        cs.shade = color(r.u32());
        cs.shadowColor = color(r.u32());
        if (r.left >= 2) cs.borderFillId = r.u16();
        if (r.left >= 4) cs.strikeColor = color(r.u32());
        doc.charShapes.push(cs);
        break;
      }
      case TAG.TAB_DEF: {
        const attr = r.u32(); const n = r.left >= 4 ? r.i32() : 0;
        const td = { autoLeft: !!(attr & 1), autoRight: !!(attr & 2), tabs: [] };
        for (let i = 0; i < n && r.left >= 8; i++) {
          const pos = r.u32(), kind = r.u8_(), fill = r.u8_(); r.skip(2);
          td.tabs.push({ pos, kind, fill });
        }
        doc.tabDefs.push(td);
        break;
      }
      case TAG.NUMBERING: {
        // 수준별(7단계) 문단 번호 형식
        const nb = { levels: [], start: 1 };
        try {
          for (let i = 0; i < 7; i++) {
            const a = r.u32(); const widthAdjust = r.i16(); const distance = r.i16(); const charShape = r.u32();
            const format = r.str();
            nb.levels.push({ align: a & 3, numFormat: (a >> 5) & 0x1f, widthAdjust, distance, charShape, format, start: 1 });
          }
          nb.start = r.u16();
          if (r.left >= 28) for (let i = 0; i < 7; i++) nb.levels[i].start = r.u32();
        } catch { /* 구버전 레코드는 짧을 수 있음 */ }
        doc.numberings.push(nb);
        break;
      }
      case TAG.BULLET: {
        try {
          r.u32(); r.i16(); r.i16(); r.u32();
          doc.bullets.push({ char: String.fromCharCode(r.u16()) });
        } catch { doc.bullets.push({ char: '•' }); }
        break;
      }
      case TAG.PARA_SHAPE: {
        const a = r.u32();
        const ps = {
          lineSpacingType: a & 3, align: (a >> 2) & 7, breakLatin: (a >> 5) & 3, breakHangul: (a >> 7) & 1,
          widowOrphan: !!(a & (1 << 16)), keepWithNext: !!(a & (1 << 17)), keepLines: !!(a & (1 << 18)),
          pageBreakBefore: !!(a & (1 << 19)), fontLineHeight: !!(a & (1 << 22)),
          headType: (a >> 23) & 3, headLevel: (a >> 25) & 7,
        };
        // 여백·들여쓰기·문단 간격은 파일에 2배 값으로 저장되어 있다
        ps.left = r.i32() / 2; ps.right = r.i32() / 2; ps.indent = r.i32() / 2;
        ps.before = r.i32() / 2; ps.after = r.i32() / 2;
        ps.lineSpacing = r.i32();
        ps.tabDefId = r.u16(); ps.numberingId = r.u16(); ps.borderFillId = r.u16();
        ps.borderLeft = r.i16(); ps.borderRight = r.i16(); ps.borderTop = r.i16(); ps.borderBottom = r.i16();
        if (r.left >= 4) { const a2 = r.u32(); ps.autoSpaceEn = !!(a2 & (1 << 4)); ps.autoSpaceNum = !!(a2 & (1 << 5)); }
        if (r.left >= 8) { const a3 = r.u32(); ps.lineSpacingType = a3 & 0x1f; ps.lineSpacing = r.u32(); }
        doc.paraShapes.push(ps);
        break;
      }
      case TAG.STYLE: {
        const name = r.str(), engName = r.str();
        const attr = r.u8_(), next = r.u8_(); r.i16();
        const paraShape = r.u16(), charShape = r.u16();
        doc.styles.push({ name, engName, kind: attr & 7, next, paraShape, charShape });
        break;
      }
    }
  }
  return doc;
}

// 문단 텍스트 안의 제어 문자 분류 (WCHAR 8개를 차지하는 것과 1개를 차지하는 것)
const CHAR_CTRL = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);
const INLINE_CTRL = new Set([4, 5, 6, 7, 8, 9, 19, 20]);

function ctrlIdStr(v) {
  return String.fromCharCode((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function parseObjCommon(r) {
  const a = r.u32();
  const o = {
    inline: !!(a & 1), vertRel: (a >> 3) & 3, vertAlign: (a >> 5) & 7, horzRel: (a >> 8) & 3, horzAlign: (a >> 10) & 7,
    wrap: (a >> 21) & 7,   // 0 어울림, 1 자리 차지, 2 글 뒤로, 3 글 앞으로
  };
  o.y = r.i32(); o.x = r.i32(); o.width = r.u32(); o.height = r.u32(); o.z = r.i32();
  o.marginLeft = r.u16(); o.marginRight = r.u16(); o.marginTop = r.u16(); o.marginBottom = r.u16();
  return o;
}

function parseParaList(nodes, ctx) {
  return nodes.filter(n => n.tag === TAG.PARA_HEADER).map(n => parsePara(n, ctx));
}

function parseCtrl(node, ctx) {
  const r = new Reader(node.data);
  const id = ctrlIdStr(r.u32());
  const ctrl = { id };
  const kids = node.children;
  switch (id) {
    case 'secd': {
      r.u32(); r.u16(); r.u16(); r.u16();
      ctrl.defaultTab = r.left >= 4 ? r.u32() : 4000;
      const pd = kids.find(k => k.tag === TAG.PAGE_DEF);
      if (pd) {
        const p = new Reader(pd.data);
        ctrl.page = {
          width: p.u32(), height: p.u32(), left: p.u32(), right: p.u32(), top: p.u32(), bottom: p.u32(),
          header: p.u32(), footer: p.u32(), gutter: p.u32(),
        };
        ctrl.page.landscape = !!(p.u32() & 1);
      }
      break;
    }
    case 'cold': {
      const a = r.u16();
      ctrl.count = (a >> 2) & 0xff; ctrl.sameWidth = !!(a & (1 << 12));
      ctrl.gap = r.left >= 2 ? r.u16() : 0;
      break;
    }
    case 'tbl ': {
      Object.assign(ctrl, parseObjCommon(r));
      const cells = []; let cur = null;
      for (const k of kids) {
        if (k.tag === TAG.TABLE) {
          const t = new Reader(k.data);
          const a = t.u32();
          ctrl.split = a & 3; ctrl.repeatHeader = !!(a & 4);
          ctrl.rows = t.u16(); ctrl.cols = t.u16(); ctrl.cellSpacing = t.u16();
          ctrl.padLeft = t.u16(); ctrl.padRight = t.u16(); ctrl.padTop = t.u16(); ctrl.padBottom = t.u16();
          t.skip(2 * ctrl.rows);
          ctrl.borderFillId = t.left >= 2 ? t.u16() : 0;
        } else if (k.tag === TAG.LIST_HEADER) {
          const c = new Reader(k.data);
          c.i16(); c.u16(); const a = c.u32();
          cur = {
            valign: (a >> 5) & 3, textDir: a & 7, ownPadding: !!(a & (1 << 16)), header: !!(a & (1 << 18)),
            col: c.u16(), row: c.u16(), colSpan: c.u16(), rowSpan: c.u16(), width: c.u32(), height: c.u32(),
            padLeft: c.u16(), padRight: c.u16(), padTop: c.u16(), padBottom: c.u16(), borderFillId: c.u16(),
            paras: parseParaList(k.children, ctx),
          };
          cells.push(cur);
        } else if (k.tag === TAG.PARA_HEADER && cur) {
          cur.paras.push(parsePara(k, ctx));
        }
      }
      ctrl.cells = cells;
      break;
    }
    case 'head': case 'foot': {
      const a = r.left >= 4 ? r.u32() : 0;
      ctrl.applyTo = a & 3;   // 0 양쪽, 1 짝수, 2 홀수
      ctrl.paras = [];
      for (const k of kids) {
        if (k.tag === TAG.LIST_HEADER) ctrl.paras.push(...parseParaList(k.children, ctx));
        else if (k.tag === TAG.PARA_HEADER) ctrl.paras.push(parsePara(k, ctx));
      }
      break;
    }
    case 'pgnp': {
      const a = r.u32();
      ctrl.format = a & 0xff; ctrl.position = (a >> 8) & 0xf;
      const w = () => (r.left >= 2 ? r.u16() : 0);
      ctrl.userSymbol = w(); ctrl.prefix = w(); ctrl.suffix = w(); ctrl.dash = w();
      break;
    }
    case 'gso ': {
      Object.assign(ctrl, parseObjCommon(r));
      // 글상자 안의 글은 살려 둔다 (도형 자체는 아직 옮기지 못함)
      ctrl.paras = [];
      const walk = (ns) => { for (const k of ns) { if (k.tag === TAG.PARA_HEADER) ctrl.paras.push(parsePara(k, ctx)); else walk(k.children); } };
      walk(kids);
      break;
    }
    case 'fn  ': case 'en  ': {
      ctrl.paras = [];
      for (const k of kids) {
        if (k.tag === TAG.LIST_HEADER) ctrl.paras.push(...parseParaList(k.children, ctx));
        else if (k.tag === TAG.PARA_HEADER) ctrl.paras.push(parsePara(k, ctx));
      }
      break;
    }
    case 'atno': case 'nwno': {
      const a = r.left >= 4 ? r.u32() : 0;
      ctrl.kind = a & 0xf; ctrl.number = r.left >= 2 ? r.u16() : 0;
      break;
    }
  }
  return ctrl;
}

function parsePara(node, ctx) {
  const h = new Reader(node.data);
  const nchars = h.u32() & 0x7fffffff; h.u32();
  const para = {
    paraShape: h.u16(), style: h.u8_(), divide: h.u8_(),
    items: [], lineSegs: [], endCharShape: 0,
  };
  let text = null, shapes = [[0, 0]];
  const ctrls = [];
  for (const k of node.children) {
    if (k.tag === TAG.PARA_TEXT) text = k.data;
    else if (k.tag === TAG.PARA_CHAR_SHAPE) {
      const r = new Reader(k.data); shapes = [];
      while (r.left >= 8) shapes.push([r.u32(), r.u32()]);
    } else if (k.tag === TAG.PARA_LINE_SEG) {
      const r = new Reader(k.data);
      while (r.left >= 36) {
        const s = { pos: r.u32(), y: r.i32(), height: r.i32(), textHeight: r.i32(), baseline: r.i32(), gap: r.i32(), x: r.i32(), width: r.i32() };
        r.u32(); para.lineSegs.push(s);
      }
    } else if (k.tag === TAG.CTRL_HEADER) ctrls.push(parseCtrl(k, ctx));
  }
  const shapeAt = (pos) => { let id = shapes[0]?.[1] ?? 0; for (const [p, s] of shapes) { if (p <= pos) id = s; else break; } return id; };
  para.endCharShape = shapeAt(Math.max(0, nchars - 1));
  if (text) {
    const dv = new DataView(text.buffer, text.byteOffset, text.byteLength);
    const n = text.length >> 1; let i = 0, ci = 0, buf = '', bufCs = -1, bufPos = 0;
    const flush = () => { if (buf) para.items.push({ t: 'text', text: buf, cs: bufCs, pos: bufPos }); buf = ''; };
    while (i < n) {
      const c = dv.getUint16(i * 2, true);
      const cs = shapeAt(i);
      if (c >= 32) {
        if (cs !== bufCs) { flush(); bufCs = cs; bufPos = i; }
        if (!buf) bufPos = i;
        buf += String.fromCharCode(c); i += 1;
      } else if (CHAR_CTRL.has(c)) {
        flush();
        if (c === 10) para.items.push({ t: 'br', cs, pos: i });
        else if (c === 24) para.items.push({ t: 'text', text: '-', cs, pos: i });
        else if (c === 30) para.items.push({ t: 'text', text: ' ', cs, pos: i });
        else if (c === 31) para.items.push({ t: 'text', text: ' ', cs, pos: i });
        i += 1;
      } else if (INLINE_CTRL.has(c)) {
        flush();
        if (c === 9) para.items.push({ t: 'tab', cs, pos: i, width: n >= i + 3 ? dv.getUint32((i + 1) * 2, true) : 0 });
        i += 8;
      } else {
        flush();
        const ctrl = ctrls[ci++];
        if (ctrl) para.items.push({ t: 'ctrl', ctrl, cs, pos: i });
        i += 8;
      }
    }
    flush();
  }
  // 텍스트에 자리 표시가 없는 컨트롤(예외적인 파일)도 잃지 않게 붙여 둔다
  const used = new Set(para.items.filter(x => x.t === 'ctrl').map(x => x.ctrl));
  for (const c of ctrls) if (!used.has(c)) para.items.push({ t: 'ctrl', ctrl: c, cs: para.endCharShape, pos: 0 });
  return para;
}

export function parseHwp(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const cfb = CFB.read(u8, { type: 'array' });
  const get = (name) => { const e = CFB.find(cfb, name); return e ? new Uint8Array(e.content) : null; };
  const fh = get('/FileHeader') ?? get('FileHeader');
  if (!fh || String.fromCharCode(...fh.subarray(0, 17)) !== 'HWP Document File') throw new Error('HWP 5.0 문서가 아닙니다.');
  const flags = new DataView(fh.buffer, fh.byteOffset).getUint32(36, true);
  if (flags & 2) throw new Error('암호가 걸린 문서는 변환할 수 없습니다.');
  if (flags & 4) throw new Error('배포용 문서는 변환할 수 없습니다.');
  const compressed = !!(flags & 1);
  const version = [fh[35], fh[34], fh[33], fh[32]];
  const stream = (name) => { const d = get(name); if (!d) return null; return compressed ? inflateSync(d) : d; };
  const doc = parseDocInfo(stream('/DocInfo') ?? stream('DocInfo'), version);
  doc.version = version.join('.');
  doc.sections = [];
  for (let i = 0; ; i++) {
    const s = stream(`/BodyText/Section${i}`) ?? stream(`BodyText/Section${i}`);
    if (!s) break;
    doc.sections.push({ paras: parseParaList(recordTree(s), {}) });
  }
  return doc;
}
