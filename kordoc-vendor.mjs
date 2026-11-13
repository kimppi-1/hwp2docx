// kordoc 4.24.74 에서 가져온 수식 변환·배포용 문서 복호 코드 (MIT License, Copyright (c) 2026 chrisryugj)
// https://github.com/chrisryugj/kordoc — esbuild로 묶은 파일이므로 직접 고치지 말 것
// hwp2docx 수정: 워드 수식 배열(eqArr)을 줄 단위로, 왼쪽 중괄호+배열을 cases로 읽음
// ../../build/ksrc/hwpx/equation.ts
var CONVERT_MAP = {
  TIMES: "\\times",
  times: "\\times",
  LEFT: "\\left",
  RIGHT: "\\right",
  under: "\\underline",
  SMALLSUM: "\\sum",
  sum: "\\sum",
  SMALLPROD: "\\prod",
  prod: "\\prod",
  SMALLINTER: "\\cap",
  CUP: "\\cup",
  OPLUS: "\\oplus",
  OMINUS: "\\ominus",
  OTIMES: "\\otimes",
  ODIV: "\\oslash",
  ODOT: "\\odot",
  LOR: "\\lor",
  LAND: "\\land",
  SUBSET: "\\subset",
  SUPERSET: "\\supset",
  SUBSETEQ: "\\subseteq",
  SUPSETEQ: "\\supseteq",
  IN: "\\in",
  OWNS: "\\owns",
  NOTIN: "\\notin",
  LEQ: "\\leq",
  GEQ: "\\geq",
  "<<": "\\ll",
  ">>": "\\gg",
  "<<<": "\\lll",
  ">>>": "\\ggg",
  PREC: "\\prec",
  SUCC: "\\succ",
  UPLUS: "\\uplus",
  "\xB1": "\\pm",
  "+-": "\\pm",
  "-+": "\\mp",
  "\xF7": "\\div",
  cdot: "\\cdot",
  CIRC: "\\circ",
  BULLET: "\\bullet",
  DEG: " ^\\circ",
  AST: "\\ast",
  STAR: "\\bigstar",
  BIGCIRC: "\\bigcirc",
  EMPTYSET: "\\emptyset",
  THEREFORE: "\\therefore",
  BECAUSE: "\\because",
  EXIST: "\\exists",
  // 한글 수식 편집기는 소문자 therefore·because 도 같은 기호로 그린다(#148) — 생성 쪽 정준형은 대문자(equation-generate COMMAND_MAP)
  therefore: "\\therefore",
  because: "\\because",
  "!=": "\\neq",
  SMCOPROD: "\\coprod",
  coprod: "\\coprod",
  SQCAP: "\\sqcap",
  SQCUP: "\\sqcup",
  SQSUBSET: "\\sqsubset",
  SQSUBSETEQ: "\\sqsubseteq",
  BIGSQCUP: "\\bigsqcup",
  BIGOPLUS: "\\bigoplus",
  BIGOTIMES: "\\bigotimes",
  BIGODOT: "\\bigodot",
  BIGUPLUS: "\\biguplus",
  inter: "\\bigcap",
  union: "\\bigcup",
  BIGOMINUS: "{\\Large\\ominus}",
  BIGODIV: "{\\Large\\oslash}",
  UNDEROVER: "",
  SIM: "\\sim",
  APPROX: "\\approx",
  SIMEQ: "\\simeq",
  CONG: "\\cong",
  "==": "\\equiv",
  DIAMOND: "\\diamond",
  FORALL: "\\forall",
  prime: "'",
  Partial: "\\partial",
  INF: "\\infty",
  PROPTO: "\\propto",
  lim: "\\lim",
  Lim: "\\lim",
  larrow: "\\leftarrow",
  "->": "\\rightarrow",
  uparrow: "\\uparrow",
  downarrow: "\\downarrow",
  LARROW: "\\Leftarrow",
  RARROW: "\\Rightarrow",
  UPARROW: "\\Uparrow",
  DOWNARROW: "\\Downarrow",
  udarrow: "\\updownarrow",
  "<->": "\\leftrightarrow",
  UDARROW: "\\Updownarrow",
  LRARROW: "\\Leftrightarrow",
  NWARROW: "\\nwarrow",
  SEARROW: "\\searrow",
  NEARROW: "\\nearrow",
  SWARROW: "\\swarrow",
  HOOKLEFT: "\\hookleftarrow",
  HOOKRIGHT: "\\hookrightarrow",
  PVER: "\\|",
  MAPSTO: "\\mapsto",
  CDOTS: "\\cdots",
  LDOTS: "\\ldots",
  VDOTS: "\\vdots",
  DDOTS: "\\ddots",
  DAGGER: "\\dagger",
  DDAGGER: "\\ddagger",
  DOTEQ: "\\doteq",
  image: "\\fallingdotseq",
  REIMAGE: "\\risingdotseq",
  ASYMP: "\\asymp",
  ISO: "\\Bumpeq",
  DSUM: "\\dotplus",
  XOR: "\\veebar",
  TRIANGLE: "\\triangle",
  NABLA: "\\nabla",
  ANGLE: "\\angle",
  MSANGLE: "\\measuredangle",
  SANGLE: "\\sphericalangle",
  VDASH: "\\vdash",
  DASHV: "\\dashv",
  BOT: "\\bot",
  TOP: "\\top",
  MODELS: "\\models",
  LAPLACE: "\\mathcal{L}",
  CENTIGRADE: "^{\\circ}C",
  FAHRENHEIT: "^{\\circ}F",
  LSLANT: "\\diagup",
  RSLANT: "\\diagdown",
  sqrt: "\\sqrt",
  int: "\\int",
  dint: "\\iint",
  tint: "\\iiint",
  oint: "\\oint",
  alpha: "\\alpha",
  beta: "\\beta",
  gamma: "\\gamma",
  delta: "\\delta",
  epsilon: "\\epsilon",
  zeta: "\\zeta",
  eta: "\\eta",
  theta: "\\theta",
  iota: "\\iota",
  kappa: "\\kappa",
  lambda: "\\lambda",
  mu: "\\mu",
  nu: "\\nu",
  xi: "\\xi",
  omicron: "\\omicron",
  pi: "\\pi",
  rho: "\\rho",
  sigma: "\\sigma",
  tau: "\\tau",
  upsilon: "\\upsilon",
  phi: "\\phi",
  chi: "\\chi",
  psi: "\\psi",
  omega: "\\omega",
  ALPHA: "A",
  BETA: "B",
  GAMMA: "\\Gamma",
  DELTA: "\\Delta",
  EPSILON: "E",
  ZETA: "Z",
  ETA: "H",
  THETA: "\\Theta",
  IOTA: "I",
  KAPPA: "K",
  LAMBDA: "\\Lambda",
  MU: "M",
  NU: "N",
  XI: "\\Xi",
  OMICRON: "O",
  PI: "\\Pi",
  RHO: "P",
  SIGMA: "\\Sigma",
  TAU: "T",
  UPSILON: "\\Upsilon",
  PHI: "\\Phi",
  CHI: "X",
  PSI: "\\Psi",
  OMEGA: "\\Omega",
  "\u2308": "\\lceil",
  "\u2309": "\\rceil",
  "\u230A": "\\lfloor",
  "\u230B": "\\rfloor",
  "\u2225": "\\|",
  "\u2290": "\\sqsupset",
  "\u2292": "\\sqsupseteq",
  odint: "\\mathop \u222F",
  otint: "\\mathop \u2230",
  BIGSQCAP: "\\mathop \u2A05",
  ATT: "\\mathop \u203B",
  HUND: "\\mathop \u2030",
  THOU: "\\mathop \u2031",
  IDENTICAL: "\\mathop \u2237",
  RTANGLE: "\\mathop \u22BE",
  BASE: "\\mathop \u2302",
  BENZENE: "\\mathop \u232C"
};
var MIDDLE_CONVERT_MAP = {
  matrix: "HULKMATRIX",
  pmatrix: "HULKPMATRIX",
  bmatrix: "HULKBMATRIX",
  dmatrix: "HULKDMATRIX",
  eqalign: "HULKEQALIGN",
  cases: "HULKCASE",
  vec: "HULKVEC",
  dyad: "HULKDYAD",
  acute: "HULKACUTE",
  grave: "HULKGRAVE",
  dot: "HULKDOT",
  ddot: "HULKDDOT",
  bar: "HULKBAR",
  hat: "HULKHAT",
  check: "HULKCHECK",
  arch: "HULKARCH",
  tilde: "HULKTILDE",
  BOX: "HULKBOX",
  OVERBRACE: "HULKOVERBRACE",
  UNDERBRACE: "HULKUNDERBRACE"
};
var BAR_CONVERT_MAP = {
  HULKVEC: "\\overrightarrow",
  HULKDYAD: "\\overleftrightarrow",
  HULKACUTE: "\\acute",
  HULKGRAVE: "\\grave",
  HULKDOT: "\\dot",
  HULKDDOT: "\\ddot",
  HULKBAR: "\\overline",
  HULKHAT: "\\widehat",
  HULKCHECK: "\\check",
  HULKARCH: "\\overset{\\frown}",
  HULKTILDE: "\\widetilde",
  HULKBOX: "\\boxed"
};
var MATRIX_CONVERT_MAP = {
  HULKMATRIX: { begin: "\\begin{matrix}", end: "\\end{matrix}", removeOutterBrackets: true },
  HULKPMATRIX: { begin: "\\begin{pmatrix}", end: "\\end{pmatrix}", removeOutterBrackets: true },
  HULKBMATRIX: { begin: "\\begin{bmatrix}", end: "\\end{bmatrix}", removeOutterBrackets: true },
  HULKDMATRIX: { begin: "\\begin{vmatrix}", end: "\\end{vmatrix}", removeOutterBrackets: true },
  HULKCASE: { begin: "\\begin{cases}", end: "\\end{cases}", removeOutterBrackets: true },
  HULKEQALIGN: { begin: "\\eqalign{", end: "}", removeOutterBrackets: false }
};
var BRACE_CONVERT_MAP = {
  HULKOVERBRACE: "\\overbrace",
  HULKUNDERBRACE: "\\underbrace"
};
function findBrackets(eqString, startIdx) {
  const startCur = eqString.indexOf("{", startIdx);
  if (startCur === -1) throw new Error("cannot find bracket");
  let bracketCount = 1;
  for (let i = startCur + 1; i < eqString.length; i++) {
    const ch = eqString[i];
    if (ch === "{") bracketCount += 1;
    else if (ch === "}") bracketCount -= 1;
    if (bracketCount === 0) return [startCur, i + 1];
  }
  throw new Error("cannot find bracket");
}
function findEnclosingBrackets(eqString, startIdx) {
  let depth = 0;
  for (let idx = startIdx - 1; idx >= 0; idx--) {
    const ch = eqString[idx];
    if (ch === "}") {
      depth += 1;
    } else if (ch === "{") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      try {
        const [start, end] = findBrackets(eqString, idx);
        if (start === idx && end > startIdx) return [start, end];
      } catch {
        return null;
      }
      return null;
    }
  }
  return null;
}
function maskLiteralSpans(eqString) {
  return eqString.replace(/"[^"]*"/g, (m) => "\uFFFF".repeat(m.length)).replace(/\\text\{[^}]*\}/g, (m) => "\uFFFF".repeat(m.length));
}
function findKeywordToken(eqString, word, from = 0) {
  const masked = maskLiteralSpans(eqString);
  for (let i = masked.indexOf(word, from); i !== -1; i = masked.indexOf(word, i + 1)) {
    const okL = i === 0 || /\s/.test(masked[i - 1]);
    const okR = i + word.length === masked.length || /\s/.test(masked[i + word.length]);
    if (okL && okR) return i;
  }
  return -1;
}
function replaceFrac(eqString) {
  const hmlFrac = "over";
  const masked = maskLiteralSpans(eqString);
  const out = [];
  let pos = 0;
  for (let cursor = masked.indexOf(hmlFrac); cursor !== -1; cursor = masked.indexOf(hmlFrac, cursor + 1)) {
    const okL = cursor === 0 || /\s/.test(masked[cursor - 1]);
    const okR = cursor + hmlFrac.length === masked.length || /\s/.test(masked[cursor + hmlFrac.length]);
    if (!okL || !okR) continue;
    for (; pos < cursor; pos++) out.push(eqString[pos]);
    let end = out.length;
    while (end > 0 && /\s/.test(out[end - 1])) end--;
    let numStart = end;
    if (end > 0 && out[end - 1] === "}") {
      let depth = 0;
      for (numStart = end - 1; numStart >= 0; numStart--) {
        if (out[numStart] === "}") depth++;
        else if (out[numStart] === "{" && --depth === 0) break;
      }
      if (numStart < 0) break;
      out.length = end;
      out.splice(numStart, 0, "\\frac");
    } else {
      while (numStart > 0 && !/\s/.test(out[numStart - 1])) numStart--;
      if (numStart === end) break;
      out.length = end;
      out.splice(numStart, 0, "\\frac", "{");
      out.push("}");
    }
    pos = cursor + hmlFrac.length;
  }
  return out.join("") + eqString.slice(pos);
}
function replaceRootOf(eqString) {
  while (true) {
    const rootCursor = findKeywordToken(eqString, "root");
    if (rootCursor === -1) break;
    try {
      const elem1 = findBrackets(eqString, rootCursor);
      const ofCursor = findKeywordToken(eqString, "of", elem1[1]);
      if (ofCursor === -1) return eqString;
      const elem2 = findBrackets(eqString, ofCursor);
      const e1 = eqString.slice(elem1[0] + 1, elem1[1] - 1);
      const e2 = eqString.slice(elem2[0] + 1, elem2[1] - 1);
      eqString = eqString.slice(0, rootCursor) + "\\sqrt[" + e1 + "]{" + e2 + "}" + eqString.slice(elem2[1] + 1);
    } catch {
      return eqString;
    }
  }
  return eqString;
}
function replaceAllMatrix(eqString) {
  const replaceElements = (bracketStr) => {
    let inner = bracketStr.slice(1, -1);
    inner = inner.replace(/#/g, " \\\\ ");
    inner = inner.replace(/&amp;/g, "&");
    return inner;
  };
  const replaceMatrix = (input, matStr, matElem) => {
    while (true) {
      const cursor = input.indexOf(matStr);
      if (cursor === -1) break;
      try {
        const [eStart, eEnd] = findBrackets(input, cursor);
        const elem = replaceElements(input.slice(eStart, eEnd));
        let beforeMat;
        let afterMat;
        const outer = matElem.removeOutterBrackets ? findEnclosingBrackets(input, cursor) : null;
        if (outer && outer[1] >= eEnd) {
          const [bStart, bEnd] = outer;
          beforeMat = input.slice(0, bStart);
          afterMat = input.slice(bEnd);
        } else {
          beforeMat = input.slice(0, cursor);
          afterMat = input.slice(eEnd);
        }
        input = beforeMat + matElem.begin + elem + matElem.end + afterMat;
      } catch {
        return input;
      }
    }
    return input;
  };
  for (const [matKey, matElem] of Object.entries(MATRIX_CONVERT_MAP)) {
    eqString = replaceMatrix(eqString, matKey, matElem);
  }
  return eqString;
}
function replaceAllBar(eqString) {
  const replaceBar = (input, barStr, barElem) => {
    while (true) {
      const cursor = input.indexOf(barStr);
      if (cursor === -1) break;
      try {
        const [eStart, eEnd] = findBrackets(input, cursor);
        const elem = input.slice(eStart, eEnd);
        const outer = findEnclosingBrackets(input, cursor);
        const [replaceStart, replaceEnd] = outer && outer[1] >= eEnd ? outer : [cursor, eEnd];
        const beforeBar = input.slice(0, replaceStart);
        const afterBar = input.slice(replaceEnd);
        input = beforeBar + barElem + elem + afterBar;
      } catch {
        return input;
      }
    }
    return input;
  };
  for (const [barKey, barElem] of Object.entries(BAR_CONVERT_MAP)) {
    eqString = replaceBar(eqString, barKey, barElem);
  }
  return eqString;
}
function replaceAllBrace(eqString) {
  const replaceBrace = (input, braceStr, braceElem) => {
    while (true) {
      const cursor = input.indexOf(braceStr);
      if (cursor === -1) break;
      try {
        const [eStart1, eEnd1] = findBrackets(input, cursor);
        const [eStart2, eEnd2] = findBrackets(input, eEnd1);
        const elem1 = input.slice(eStart1, eEnd1);
        const elem2 = input.slice(eStart2, eEnd2);
        const beforeBrace = input.slice(0, cursor);
        const afterBrace = input.slice(eEnd2);
        input = beforeBrace + braceElem + elem1 + "^" + elem2 + afterBrace;
      } catch {
        return input;
      }
    }
    return input;
  };
  for (const [braceKey, braceElem] of Object.entries(BRACE_CONVERT_MAP)) {
    eqString = replaceBrace(eqString, braceKey, braceElem);
  }
  return eqString;
}
function replaceBracket(strList) {
  for (let i = 0; i < strList.length; i++) {
    if (strList[i] === "{" && i > 0 && strList[i - 1] === "\\left") strList[i] = "\\{";
    if (strList[i] === "}" && i > 0 && strList[i - 1] === "\\right") strList[i] = "\\}";
  }
  return strList;
}
function hmlToLatex(hmlEqStr) {
  if (!hmlEqStr) return "";
  let s = hmlEqStr.replace(/[\r\n\t]+/g, " ").replace(/`/g, " ");
  s = s.replace(/\{/g, " { ").replace(/\}/g, " } ").replace(/&/g, " & ");
  let tokens = s.split(" ");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (Object.hasOwn(CONVERT_MAP, t)) tokens[i] = CONVERT_MAP[t];
    else if (Object.hasOwn(MIDDLE_CONVERT_MAP, t)) tokens[i] = MIDDLE_CONVERT_MAP[t];
    else {
      const quoted = /^"(.+)"$/.exec(t);
      if (quoted) tokens[i] = `\\text{${quoted[1]}}`;
    }
  }
  tokens = tokens.filter((tok) => tok.length !== 0);
  tokens = replaceBracket(tokens);
  let out = tokens.join(" ");
  out = replaceFrac(out);
  out = replaceRootOf(out);
  out = replaceAllMatrix(out);
  out = replaceAllBar(out);
  out = replaceAllBrace(out);
  return out;
}

// ../../build/ksrc/hwp5/equation.ts
var WORD_ALIASES = {
  // 삼각/로그 함수 — 정본 맵 부재
  sin: "\\sin",
  cos: "\\cos",
  tan: "\\tan",
  sec: "\\sec",
  csc: "\\csc",
  cot: "\\cot",
  log: "\\log",
  ln: "\\ln",
  // 연산자·관계 기호 (정본은 대문자 키만 보유)
  divide: "\\div",
  div: "\\div",
  le: "\\leq",
  ge: "\\geq",
  geq: "\\geq",
  deg: "^\\circ",
  rarrow: "\\rightarrow",
  lrarrow: "\\leftrightarrow",
  rightarrow: "\\rightarrow",
  leftarrow: "\\leftarrow",
  in: "\\in",
  notin: "\\notin",
  emptyset: "\\emptyset",
  subset: "\\subset",
  nsubset: "\\nsubseteq",
  cup: "\\cup",
  cap: "\\cap",
  smallinter: "\\cap",
  smallsum: "\\sum",
  sim: "\\sim",
  circ: "\\circ",
  bot: "\\perp",
  partial: "\\partial",
  nabla: "\\nabla",
  angle: "\\angle",
  triangle: "\\triangle",
  inf: "\\infty",
  left: "\\left",
  right: "\\right",
  // 글꼴 지시자 — 제거
  rm: "",
  it: ""
};
var STRUCTURAL_FOLD = /* @__PURE__ */ new Set(["over", "root", "of"]);
function normalizeWords(input) {
  return input.replace(/(?<![\\A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)(?![A-Za-z0-9])/g, (word) => {
    if (Object.hasOwn(CONVERT_MAP, word) || Object.hasOwn(MIDDLE_CONVERT_MAP, word)) return word;
    const lower = word.toLowerCase();
    if (STRUCTURAL_FOLD.has(lower)) return lower;
    if (Object.hasOwn(WORD_ALIASES, lower)) return WORD_ALIASES[lower];
    if (lower !== word && (Object.hasOwn(CONVERT_MAP, lower) || Object.hasOwn(MIDDLE_CONVERT_MAP, lower))) return lower;
    return word;
  });
}
function normalizeScripts(input) {
  return input.replace(/\s*\^\s*/g, "^").replace(/\s*_\s*/g, "_").replace(/\^(?!\{)([^\s{}_^]+)/g, "^{$1}").replace(/_(?!\{)([^\s{}_^]+)/g, "_{$1}").replace(/([_^])/g, " $1 ");
}
function normalizeOperators(input) {
  return input.replace(/\+-/g, " \\pm ").replace(/-\+/g, " \\mp ").replace(/\/\//g, " \\parallel ").replace(/!=/g, " \\neq ").replace(/<=/g, " \\leq ").replace(/>=/g, " \\geq ").replace(/==/g, " \\equiv ").replace(/△/g, " \\triangle ").replace(/□/g, " \\square ").replace(/‧/g, " \\cdot ");
}
function hwpEquationToLatex(equation) {
  let s = equation.replace(/\0/g, "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = normalizeScripts(s);
  s = normalizeOperators(s);
  s = normalizeWords(s);
  s = s.replace(/\broot\s+(?!\{)(\S+)\s+of(?![A-Za-z0-9])/gi, "root { $1 } of");
  return hmlToLatex(s).replace(/\s+/g, " ").trim();
}

// ../../build/ksrc/shared/xml.ts
function localName(el) {
  return (el.tagName || el.localName || "").replace(/^[^:]+:/, "");
}
function findChildByLocalName(parent, name) {
  const children = parent.childNodes;
  if (!children) return null;
  for (let i = 0; i < children.length; i++) {
    const ch = children[i];
    if (ch.nodeType !== 1) continue;
    if (localName(ch) === name) return ch;
  }
  return null;
}
function childrenByLocalName(parent, name) {
  const out = [];
  const children = parent.childNodes;
  if (!children) return out;
  for (let i = 0; i < children.length; i++) {
    const ch = children[i];
    if (ch.nodeType !== 1) continue;
    if (localName(ch) === name) out.push(ch);
  }
  return out;
}
function elementChildren(parent) {
  const out = [];
  const children = parent.childNodes;
  if (!children) return out;
  for (let i = 0; i < children.length; i++) {
    if (children[i].nodeType === 1) out.push(children[i]);
  }
  return out;
}

// ../../build/ksrc/docx/equation.ts
function runToLatex(r) {
  let out = "";
  for (const t of childrenByLocalName(r, "t")) out += t.textContent ?? "";
  return out.replace(/[#%]/g, "\\$&");
}
function join(a, b) {
  return /\\[A-Za-z]+$/.test(a) && /^[A-Za-z]/.test(b) ? a + " " + b : a + b;
}
var EQ_NUMBER_RE = /\s*\\#\s*(?:\\left\((.+)\\right\)|\(([^()]*)\))\s*$/;
var FUNC_NAMES = /* @__PURE__ */ new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "sinh",
  "cosh",
  "tanh",
  "coth",
  "arcsin",
  "arccos",
  "arctan",
  "log",
  "ln",
  "lg",
  "exp",
  "det",
  "dim",
  "gcd",
  "inf",
  "sup",
  "lim",
  "max",
  "min",
  "Pr",
  "arg"
]);
var ACCENT_MAP = {
  "\u0302": "\\hat",
  // U+0302 COMBINING CIRCUMFLEX
  "\u0303": "\\tilde",
  // U+0303
  "\u0304": "\\bar",
  // U+0304
  "\u0307": "\\dot",
  // U+0307
  "\u0308": "\\ddot",
  // U+0308
  "\u0301": "\\acute",
  // U+0301
  "\u0300": "\\grave",
  // U+0300
  "\u0306": "\\breve",
  // U+0306
  "\u030C": "\\check",
  // U+030C
  "\u20D7": "\\vec",
  // U+20D7 COMBINING RIGHT ARROW ABOVE
  "\u2192": "\\vec"
};
var NARY_MAP = {
  "\u2211": "\\sum",
  "\u220F": "\\prod",
  "\u2210": "\\coprod",
  "\u222B": "\\int",
  "\u222C": "\\iint",
  "\u222D": "\\iiint",
  "\u222E": "\\oint",
  "\u222F": "\\oiint",
  "\u2230": "\\oiiint",
  "\u22C3": "\\bigcup",
  "\u22C2": "\\bigcap",
  "\u2A01": "\\bigoplus",
  "\u2A02": "\\bigotimes",
  "\u2A00": "\\bigodot"
};
function onOffVal(v) {
  return v !== "0" && v !== "false" && v !== "off";
}
function mapDelim(ch, isLeft) {
  const l = {
    "(": "(",
    "[": "[",
    "{": "\\{",
    "\u27E8": "\\langle",
    "|": "|",
    "\u2016": "\\|",
    "\u230A": "\\lfloor",
    "\u2308": "\\lceil",
    "": "."
  };
  const r = {
    ")": ")",
    "]": "]",
    "}": "\\}",
    "\u27E9": "\\rangle",
    "|": "|",
    "\u2016": "\\|",
    "\u230B": "\\rfloor",
    "\u2309": "\\rceil",
    "": "."
  };
  const map = isLeft ? l : r;
  return map[ch] ?? ch;
}
function isBalancedWrap(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{" && s[i - 1] !== "\\") depth++;
    else if (ch === "}" && s[i - 1] !== "\\") {
      depth--;
      if (depth === 0) return i === s.length - 1;
      if (depth < 0) return false;
    }
  }
  return false;
}
function grp(body) {
  const s = body.trim();
  if (s.length === 0) return "{}";
  if (s.startsWith("{") && s.endsWith("}") && isBalancedWrap(s)) return s;
  return "{" + s + "}";
}
function childrenToLatex(parent) {
  let out = "";
  for (const ch of elementChildren(parent)) {
    out = join(out, nodeToLatex(ch));
  }
  return out;
}
function nodeToLatex(el) {
  const tag = localName(el);
  switch (tag) {
    case "r":
      return runToLatex(el);
    case "e":
    // generic container (인자로 쓰임) — 자식 연결
    case "num":
    case "den":
    case "sub":
    case "sup":
    case "deg":
    case "lim":
    case "fName":
      return childrenToLatex(el);
    // 분수
    case "f": {
      const n = findChildByLocalName(el, "num");
      const d = findChildByLocalName(el, "den");
      const num = n ? childrenToLatex(n) : "";
      const den = d ? childrenToLatex(d) : "";
      return "\\frac" + grp(num) + grp(den);
    }
    // 첨자
    case "sSup": {
      const e = findChildByLocalName(el, "e");
      const sup = findChildByLocalName(el, "sup");
      return grp(e ? childrenToLatex(e) : "") + "^" + grp(sup ? childrenToLatex(sup) : "");
    }
    case "sSub": {
      const e = findChildByLocalName(el, "e");
      const sub = findChildByLocalName(el, "sub");
      return grp(e ? childrenToLatex(e) : "") + "_" + grp(sub ? childrenToLatex(sub) : "");
    }
    case "sSubSup": {
      const e = findChildByLocalName(el, "e");
      const sub = findChildByLocalName(el, "sub");
      const sup = findChildByLocalName(el, "sup");
      return grp(e ? childrenToLatex(e) : "") + "_" + grp(sub ? childrenToLatex(sub) : "") + "^" + grp(sup ? childrenToLatex(sup) : "");
    }
    case "sPre": {
      const sub = findChildByLocalName(el, "sub");
      const sup = findChildByLocalName(el, "sup");
      const e = findChildByLocalName(el, "e");
      const preSub = sub ? grp(childrenToLatex(sub)) : "{}";
      const preSup = sup ? grp(childrenToLatex(sup)) : "{}";
      const body = e ? childrenToLatex(e) : "";
      return "{}_" + preSub + "^" + preSup + grp(body);
    }
    // 근호
    case "rad": {
      const deg = findChildByLocalName(el, "deg");
      const e = findChildByLocalName(el, "e");
      const body = e ? childrenToLatex(e) : "";
      const radPr = findChildByLocalName(el, "radPr");
      let hide = false;
      if (radPr) {
        const degHide = findChildByLocalName(radPr, "degHide");
        if (degHide) {
          const val = degHide.getAttribute("m:val") ?? degHide.getAttribute("val");
          hide = val === "1" || val === "on" || val === "true";
        }
      }
      const degStr = !hide && deg ? childrenToLatex(deg).trim() : "";
      return degStr ? "\\sqrt[" + degStr + "]" + grp(body) : "\\sqrt" + grp(body);
    }
    // n-ary 연산자 (sum, prod, int, …)
    case "nary": {
      const naryPr = findChildByLocalName(el, "naryPr");
      let op = "\\int";
      let subHide = false;
      let supHide = false;
      let limLoc = "";
      if (naryPr) {
        const chr = findChildByLocalName(naryPr, "chr");
        if (chr) {
          const v = chr.getAttribute("m:val") ?? chr.getAttribute("val") ?? "";
          if (v && NARY_MAP[v]) op = NARY_MAP[v];
          else if (v) op = v;
        } else {
          op = "\\int";
        }
        const sh = findChildByLocalName(naryPr, "subHide");
        const ph = findChildByLocalName(naryPr, "supHide");
        if (sh) subHide = onOffVal(sh.getAttribute("m:val") ?? sh.getAttribute("val"));
        if (ph) supHide = onOffVal(ph.getAttribute("m:val") ?? ph.getAttribute("val"));
        const ll = findChildByLocalName(naryPr, "limLoc");
        if (ll) limLoc = ll.getAttribute("m:val") ?? ll.getAttribute("val") ?? "";
      }
      const sub = findChildByLocalName(el, "sub");
      const sup = findChildByLocalName(el, "sup");
      const e = findChildByLocalName(el, "e");
      const subStr = !subHide && sub ? childrenToLatex(sub) : "";
      const supStr = !supHide && sup ? childrenToLatex(sup) : "";
      const body = e ? childrenToLatex(e) : "";
      let head = op;
      if (limLoc === "undOvr") {
        if (subStr) head += "_" + grp(subStr);
        if (supStr) head += "^" + grp(supStr);
      } else {
        if (subStr) head += "_" + grp(subStr);
        if (supStr) head += "^" + grp(supStr);
      }
      return head + " " + body;
    }
    // 괄호 (delimiter)
    case "d": {
      const dPr = findChildByLocalName(el, "dPr");
      let beg = "(";
      let end = ")";
      let sep = ",";
      if (dPr) {
        const begChr = findChildByLocalName(dPr, "begChr");
        const endChr = findChildByLocalName(dPr, "endChr");
        const sepChr = findChildByLocalName(dPr, "sepChr");
        if (begChr) beg = begChr.getAttribute("m:val") ?? begChr.getAttribute("val") ?? beg;
        if (endChr) end = endChr.getAttribute("m:val") ?? endChr.getAttribute("val") ?? end;
        if (sepChr) sep = sepChr.getAttribute("m:val") ?? sepChr.getAttribute("val") ?? sep;
      }
      const es = childrenByLocalName(el, "e");
      if (beg === "{" && (end === "" || end === " ") && es.length === 1) {
        const inner = elementChildren(es[0]).filter((k) => localName(k) !== "ctrlPr");
        if (inner.length === 1 && localName(inner[0]) === "eqArr") {
          return "\\begin{cases}" + childrenByLocalName(inner[0], "e").map(childrenToLatex).join(" \\\\ ") + "\\end{cases}";
        }
      }
      const items = es.map(childrenToLatex);
      const body = items.join(sep);
      return join("\\left" + mapDelim(beg, true), body) + "\\right" + mapDelim(end, false);
    }
    // 행렬
    case "m": {
      const rows = [];
      for (const mr of childrenByLocalName(el, "mr")) {
        const cells = childrenByLocalName(mr, "e").map(childrenToLatex);
        rows.push(cells.join(" & "));
      }
      return "\\begin{matrix}" + rows.join(" \\\\ ") + "\\end{matrix}";
    }
    // 상자/박스 (acc 와 유사하지만 bar 가 아닌 box)
    case "box":
      return childrenToLatex(el);
    // 함수 적용 (sin, cos, log …)
    case "func": {
      const fn = findChildByLocalName(el, "fName");
      const e = findChildByLocalName(el, "e");
      const fnStr = fn ? childrenToLatex(fn).trim() : "";
      const body = e ? childrenToLatex(e) : "";
      const fnLatex = FUNC_NAMES.has(fnStr) ? "\\" + fnStr : fnStr;
      return fnLatex + grp(body);
    }
    // 악센트 (hat/bar/vec/…)
    case "acc": {
      const accPr = findChildByLocalName(el, "accPr");
      let chr = "";
      if (accPr) {
        const chrEl = findChildByLocalName(accPr, "chr");
        if (chrEl) chr = chrEl.getAttribute("m:val") ?? chrEl.getAttribute("val") ?? "";
      }
      if (!chr) chr = "\u0302";
      const e = findChildByLocalName(el, "e");
      const body = e ? childrenToLatex(e) : "";
      const cmd = ACCENT_MAP[chr] ?? "\\hat";
      return cmd + grp(body);
    }
    // bar (위/아래 줄)
    case "bar": {
      const barPr = findChildByLocalName(el, "barPr");
      let pos = "top";
      if (barPr) {
        const posEl = findChildByLocalName(barPr, "pos");
        if (posEl) pos = posEl.getAttribute("m:val") ?? posEl.getAttribute("val") ?? pos;
      }
      const e = findChildByLocalName(el, "e");
      const body = e ? childrenToLatex(e) : "";
      return (pos === "bot" ? "\\underline" : "\\overline") + grp(body);
    }
    // lim 위/아래
    case "limLow": {
      const e = findChildByLocalName(el, "e");
      const lim = findChildByLocalName(el, "lim");
      const base = e ? childrenToLatex(e).trim() : "";
      const below = lim ? childrenToLatex(lim) : "";
      if (FUNC_NAMES.has(base)) return "\\" + base + "_" + grp(below);
      return base + "_" + grp(below);
    }
    case "limUpp": {
      const e = findChildByLocalName(el, "e");
      const lim = findChildByLocalName(el, "lim");
      const base = e ? childrenToLatex(e).trim() : "";
      const above = lim ? childrenToLatex(lim) : "";
      if (FUNC_NAMES.has(base)) return "\\" + base + "^" + grp(above);
      return base + "^" + grp(above);
    }
    // group character (over/underset 비슷)
    case "groupChr":
      return childrenToLatex(findChildByLocalName(el, "e") ?? el);
    // 수식 배열 — 한 줄짜리 끝의 수식 번호 `#(43)` 는 \tag{43} (#106). 여러 줄은 종전대로 이어 붙인다
    case "eqArr": {
      const rows = childrenByLocalName(el, "e");
      const one = rows.length === 1 ? childrenToLatex(rows[0]) : "";
      const m = one.match(EQ_NUMBER_RE);
      if (m) return one.slice(0, m.index) + " \\tag{" + (m[1] ?? m[2]).trim() + "}";
      return rows.length > 1 ? "\\begin{aligned}" + rows.map(childrenToLatex).join(" \\\\ ") + "\\end{aligned}" : childrenToLatex(el);
    }
    // box/borderBox/phantom/… 는 자식 본문만 유지
    case "borderBox":
    case "phant":
      return childrenToLatex(el);
    // 최상위 컨테이너
    case "oMath":
    case "oMathPara":
      return childrenToLatex(el);
    // 메타 — 속성만 들어있으므로 출력 제외
    case "rPr":
    case "fPr":
    case "sSubPr":
    case "sSupPr":
    case "sSubSupPr":
    case "radPr":
    case "naryPr":
    case "dPr":
    case "accPr":
    case "barPr":
    case "funcPr":
    case "mPr":
    case "ctrlPr":
      return "";
    default:
      return childrenToLatex(el);
  }
}
function isOmmlRoot(el) {
  const t = localName(el);
  return t === "oMath" || t === "oMathPara";
}
function ommlElementToLatex(el) {
  if (!isOmmlRoot(el)) return "";
  const raw = childrenToLatex(el);
  return raw.replace(/\s+/g, " ").trim();
}
function isDisplayMath(el) {
  return localName(el) === "oMathPara";
}

// ../../build/ksrc/hwpx/gen-ids.ts
var CHAR_QUOTE = 10;
var GONGMUN_LIST_BASE = 8;
var GONGMUN_LIST_LEVELS = 8;
var GONGMUN_CENTER = GONGMUN_LIST_BASE + GONGMUN_LIST_LEVELS;
var GONGMUN_RIGHT = GONGMUN_CENTER + 1;
var GONGMUN_TBL_CENTER = GONGMUN_RIGHT + 1;
var GONGMUN_TBL_LEFT = GONGMUN_TBL_CENTER + 1;
var GJ_CHAR_DAE = 11;
var GJ_CHAR_SRC_BOLD = 29;
var GJ_CHAR_COUNT = GJ_CHAR_SRC_BOLD - GJ_CHAR_DAE + 1;
var GONGMUN_LIST_PLAIN_BASE = 25;
var GONGMUN_PARA_APPROVAL = GONGMUN_LIST_PLAIN_BASE + GONGMUN_LIST_LEVELS;
var GONGMUN_SRC_LEFT = GONGMUN_PARA_APPROVAL + 1;
var GONGMUN_LIST_VARIANT_BASE = GONGMUN_SRC_LEFT + 1;
var CHAR_VARIANT_BASE = CHAR_QUOTE + 1;

// ../../build/ksrc/hwpx/equation-generate.ts
var MAX_EQUATION_SOURCE = 1e4;
var MAX_GROUP_DEPTH = 64;
var COMMAND_MAP = {
  // 읽기 맵의 소문자 별칭(therefore·because, #148)이 역인덱스의 이름 일치로 정준형을 빼앗지 않게 대문자를 명시
  therefore: "THEREFORE",
  because: "BECAUSE",
  alpha: "alpha",
  beta: "beta",
  gamma: "gamma",
  delta: "delta",
  epsilon: "epsilon",
  zeta: "zeta",
  eta: "eta",
  theta: "theta",
  iota: "iota",
  kappa: "kappa",
  lambda: "lambda",
  mu: "mu",
  nu: "nu",
  xi: "xi",
  pi: "pi",
  rho: "rho",
  sigma: "sigma",
  tau: "tau",
  upsilon: "upsilon",
  phi: "phi",
  chi: "chi",
  psi: "psi",
  omega: "omega",
  Gamma: "GAMMA",
  Delta: "DELTA",
  Theta: "THETA",
  Lambda: "LAMBDA",
  Xi: "XI",
  Pi: "PI",
  Sigma: "SIGMA",
  Upsilon: "UPSILON",
  Phi: "PHI",
  Psi: "PSI",
  Omega: "OMEGA",
  le: "LEQ",
  leq: "LEQ",
  ge: "GEQ",
  geq: "GEQ",
  ne: "!=",
  neq: "!=",
  pm: "+-",
  mp: "-+",
  times: "TIMES",
  cdot: "cdot",
  ast: "AST",
  circ: "CIRC",
  bullet: "BULLET",
  in: "IN",
  notin: "NOTIN",
  subset: "SUBSET",
  subseteq: "SUBSETEQ",
  supset: "SUPERSET",
  supseteq: "SUPSETEQ",
  cup: "CUP",
  cap: "SMALLINTER",
  emptyset: "EMPTYSET",
  forall: "FORALL",
  exists: "EXIST",
  infinity: "INF",
  infty: "INF",
  partial: "Partial",
  nabla: "NABLA",
  int: "int",
  iint: "dint",
  iiint: "tint",
  oint: "oint",
  sum: "sum",
  prod: "prod",
  lim: "lim",
  to: "->",
  rightarrow: "->",
  leftarrow: "larrow",
  leftrightarrow: "<->",
  Rightarrow: "RARROW",
  Leftarrow: "LARROW",
  Leftrightarrow: "LRARROW",
  cdots: "CDOTS",
  ldots: "LDOTS",
  vdots: "VDOTS",
  ddots: "DDOTS"
};
var EQEDIT_FUNCTIONS = /* @__PURE__ */ new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "arcsin",
  "arccos",
  "arctan",
  "sinh",
  "cosh",
  "tanh",
  "coth",
  "log",
  "ln",
  "exp",
  "det",
  "gcd",
  "mod",
  "max",
  "min",
  "arg",
  "deg",
  "hom",
  "ker",
  "Pr"
]);
{
  const reverse = /* @__PURE__ */ new Map();
  const prefer = (name, a, b) => {
    if (a === name) return a;
    if (b === name) return b;
    const aAlpha = /^[A-Za-z]+$/.test(a);
    const bAlpha = /^[A-Za-z]+$/.test(b);
    if (aAlpha !== bAlpha) return aAlpha ? a : b;
    return a < b ? a : b;
  };
  for (const [token, latex] of Object.entries(CONVERT_MAP)) {
    const m = /^\\([A-Za-z]+)$/.exec(latex);
    if (!m) continue;
    const name = m[1];
    if (name in COMMAND_MAP) continue;
    const prev = reverse.get(name);
    reverse.set(name, prev === void 0 ? token : prefer(name, token, prev));
  }
  for (const [name, token] of reverse) COMMAND_MAP[name] = token;
}
var ACCENT_COMMANDS = {
  bar: "bar",
  overline: "bar",
  vec: "vec",
  overrightarrow: "vec",
  hat: "hat",
  widehat: "hat",
  tilde: "tilde",
  widetilde: "tilde",
  dot: "dot",
  ddot: "ddot",
  underline: "under"
};
var RESERVED_WORDS = new Set(
  [...Object.keys(CONVERT_MAP), ...Object.keys(MIDDLE_CONVERT_MAP), "over", "root", "of"].filter((w) => /^[A-Za-z]+$/.test(w))
);
function skipSpaces(input, idx) {
  while (idx < input.length && /\s/.test(input[idx])) idx++;
  return idx;
}
function normalizeEqEdit(input) {
  return input.replace(/\s+/g, " ").trim();
}
function stripMathDelimiters(input) {
  let s = input.trim();
  if (s.startsWith("$$") && s.endsWith("$$")) s = s.slice(2, -2).trim();
  if (s.startsWith("\\[") && s.endsWith("\\]")) s = s.slice(2, -2).trim();
  return s;
}
function readBalanced(input, idx, open, close) {
  let depth = 1;
  let cursor = idx + 1;
  while (cursor < input.length) {
    const ch = input[cursor];
    if (ch === "\\") {
      cursor += 2;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth === 0) {
      return { value: input.slice(idx + 1, cursor), next: cursor + 1 };
    }
    cursor++;
  }
  return { value: input.slice(idx + 1), next: input.length };
}
function readGroupOrToken(input, idx, depth) {
  const start = skipSpaces(input, idx);
  if (depth > MAX_GROUP_DEPTH) return { value: input.slice(start), next: input.length };
  if (input[start] === "{") {
    const group = readBalanced(input, start, "{", "}");
    return { value: convertLatexFragment(group.value, depth + 1), next: group.next };
  }
  if (input[start] === "\\") {
    const cmd = readCommand(input, start, depth + 1);
    return { value: cmd.value, next: cmd.next };
  }
  return { value: input[start] ?? "", next: Math.min(start + 1, input.length) };
}
function readCommandName(input, idx) {
  if (input[idx + 1] === "\\") return { value: "\\", next: idx + 2 };
  const match = /^[A-Za-z]+/.exec(input.slice(idx + 1));
  if (match) return { value: match[0], next: idx + 1 + match[0].length };
  return { value: input[idx + 1] ?? "", next: Math.min(idx + 2, input.length) };
}
function readCommand(input, idx, depth) {
  const name = readCommandName(input, idx);
  const command = name.value;
  if (command === "\\") return { value: "#", next: name.next };
  if (command === "frac") {
    const num = readGroupOrToken(input, name.next, depth);
    const den = readGroupOrToken(input, num.next, depth);
    return { value: `{${num.value}} over {${den.value}}`, next: den.next };
  }
  if (command === "sqrt") {
    let cursor = skipSpaces(input, name.next);
    let root = null;
    if (input[cursor] === "[") {
      const opt = readBalanced(input, cursor, "[", "]");
      root = { value: convertLatexFragment(opt.value, depth + 1), next: opt.next };
      cursor = opt.next;
    }
    const body = readGroupOrToken(input, cursor, depth);
    if (root) return { value: `root {${root.value}} of {${body.value}}`, next: body.next };
    return { value: `sqrt{${body.value}}`, next: body.next };
  }
  if (command === "begin") {
    const env = readGroupOrToken(input, name.next, depth);
    const endTag = `\\end{${env.value}}`;
    const endIdx = input.indexOf(endTag, env.next);
    if (endIdx === -1) return { value: env.value, next: env.next };
    const body = convertLatexFragment(input.slice(env.next, endIdx), depth + 1);
    const ENV_TOKEN = {
      matrix: "matrix",
      pmatrix: "pmatrix",
      bmatrix: "bmatrix",
      vmatrix: "dmatrix",
      cases: "cases",
      align: "eqalign",
      "align*": "eqalign",
      aligned: "eqalign"
    };
    const tok = ENV_TOKEN[env.value];
    if (tok) return { value: `{${tok}{${body}}}`, next: endIdx + endTag.length };
    if (env.value === "Bmatrix") {
      return { value: `LEFT { {matrix{${body}}} RIGHT }`, next: endIdx + endTag.length };
    }
    return { value: body, next: endIdx + endTag.length };
  }
  if (command === "left" || command === "right") {
    const kw = command === "left" ? "LEFT" : "RIGHT";
    const cursor = skipSpaces(input, name.next);
    let delimiter = input[cursor] ?? "";
    let next = delimiter ? cursor + 1 : cursor;
    if (delimiter === "\\") {
      const escaped = readCommandName(input, cursor);
      delimiter = escaped.value === "\\" ? "\\" : COMMAND_MAP[escaped.value] ?? escaped.value;
      next = escaped.next;
    }
    return { value: delimiter ? `${kw} ${delimiter}` : kw, next };
  }
  if (command in ACCENT_COMMANDS) {
    const body = readGroupOrToken(input, name.next, depth);
    return { value: `${ACCENT_COMMANDS[command]}{${body.value}}`, next: body.next };
  }
  if (command === ",") return { value: "`", next: name.next };
  if (command === ";" || command === ":") return { value: "~", next: name.next };
  if (command === "!") return { value: "", next: name.next };
  if (command === "mathrm" || command === "text") {
    const start = skipSpaces(input, name.next);
    if (input[start] === "{") {
      const group = readBalanced(input, start, "{", "}");
      return { value: `"${group.value}"`, next: group.next };
    }
    const tok = readGroupOrToken(input, start, depth);
    return { value: `"${tok.value}"`, next: tok.next };
  }
  const mapped = COMMAND_MAP[command];
  if (mapped !== void 0) return { value: mapped, next: name.next };
  if (EQEDIT_FUNCTIONS.has(command)) return { value: command, next: name.next };
  if (/^[A-Za-z]{2,}$/.test(command)) return { value: `"${command}"`, next: name.next };
  return { value: command, next: name.next };
}
function convertLatexFragment(input, depth) {
  if (depth > MAX_GROUP_DEPTH) return normalizeEqEdit(input);
  let out = "";
  let idx = 0;
  while (idx < input.length) {
    const ch = input[idx];
    if (ch === "\\") {
      const cmd = readCommand(input, idx, depth + 1);
      out += ` ${cmd.value} `;
      idx = cmd.next;
      continue;
    }
    if (ch === "{") {
      const group = readBalanced(input, idx, "{", "}");
      out += `{${convertLatexFragment(group.value, depth + 1)}}`;
      idx = group.next;
      continue;
    }
    if (ch === "_" || ch === "^") {
      const script = readGroupOrToken(input, idx + 1, depth);
      out += ` ${ch}{${script.value}}`;
      idx = script.next;
      continue;
    }
    if (ch === "&") {
      out += " & ";
      idx++;
      continue;
    }
    out += ch;
    idx++;
  }
  return normalizeEqEdit(out);
}
function quoteReservedKeywords(latex) {
  return latex.replace(/([_^])\s*\{\s*([A-Za-z]+)\s*\}/g, (match, op, word) => RESERVED_WORDS.has(word) ? `${op}{"${word}"}` : match);
}
function latexLikeToEqEdit(input) {
  const src = stripMathDelimiters(input);
  if (src.length > MAX_EQUATION_SOURCE) return normalizeEqEdit(src);
  return convertLatexFragment(quoteReservedKeywords(src), 0);
}

// ../../build/ksrc/hwp5/aes.ts
var S_BOX = new Uint8Array([
  99,
  124,
  119,
  123,
  242,
  107,
  111,
  197,
  48,
  1,
  103,
  43,
  254,
  215,
  171,
  118,
  202,
  130,
  201,
  125,
  250,
  89,
  71,
  240,
  173,
  212,
  162,
  175,
  156,
  164,
  114,
  192,
  183,
  253,
  147,
  38,
  54,
  63,
  247,
  204,
  52,
  165,
  229,
  241,
  113,
  216,
  49,
  21,
  4,
  199,
  35,
  195,
  24,
  150,
  5,
  154,
  7,
  18,
  128,
  226,
  235,
  39,
  178,
  117,
  9,
  131,
  44,
  26,
  27,
  110,
  90,
  160,
  82,
  59,
  214,
  179,
  41,
  227,
  47,
  132,
  83,
  209,
  0,
  237,
  32,
  252,
  177,
  91,
  106,
  203,
  190,
  57,
  74,
  76,
  88,
  207,
  208,
  239,
  170,
  251,
  67,
  77,
  51,
  133,
  69,
  249,
  2,
  127,
  80,
  60,
  159,
  168,
  81,
  163,
  64,
  143,
  146,
  157,
  56,
  245,
  188,
  182,
  218,
  33,
  16,
  255,
  243,
  210,
  205,
  12,
  19,
  236,
  95,
  151,
  68,
  23,
  196,
  167,
  126,
  61,
  100,
  93,
  25,
  115,
  96,
  129,
  79,
  220,
  34,
  42,
  144,
  136,
  70,
  238,
  184,
  20,
  222,
  94,
  11,
  219,
  224,
  50,
  58,
  10,
  73,
  6,
  36,
  92,
  194,
  211,
  172,
  98,
  145,
  149,
  228,
  121,
  231,
  200,
  55,
  109,
  141,
  213,
  78,
  169,
  108,
  86,
  244,
  234,
  101,
  122,
  174,
  8,
  186,
  120,
  37,
  46,
  28,
  166,
  180,
  198,
  232,
  221,
  116,
  31,
  75,
  189,
  139,
  138,
  112,
  62,
  181,
  102,
  72,
  3,
  246,
  14,
  97,
  53,
  87,
  185,
  134,
  193,
  29,
  158,
  225,
  248,
  152,
  17,
  105,
  217,
  142,
  148,
  155,
  30,
  135,
  233,
  206,
  85,
  40,
  223,
  140,
  161,
  137,
  13,
  191,
  230,
  66,
  104,
  65,
  153,
  45,
  15,
  176,
  84,
  187,
  22
]);
var INV_S_BOX = new Uint8Array([
  82,
  9,
  106,
  213,
  48,
  54,
  165,
  56,
  191,
  64,
  163,
  158,
  129,
  243,
  215,
  251,
  124,
  227,
  57,
  130,
  155,
  47,
  255,
  135,
  52,
  142,
  67,
  68,
  196,
  222,
  233,
  203,
  84,
  123,
  148,
  50,
  166,
  194,
  35,
  61,
  238,
  76,
  149,
  11,
  66,
  250,
  195,
  78,
  8,
  46,
  161,
  102,
  40,
  217,
  36,
  178,
  118,
  91,
  162,
  73,
  109,
  139,
  209,
  37,
  114,
  248,
  246,
  100,
  134,
  104,
  152,
  22,
  212,
  164,
  92,
  204,
  93,
  101,
  182,
  146,
  108,
  112,
  72,
  80,
  253,
  237,
  185,
  218,
  94,
  21,
  70,
  87,
  167,
  141,
  157,
  132,
  144,
  216,
  171,
  0,
  140,
  188,
  211,
  10,
  247,
  228,
  88,
  5,
  184,
  179,
  69,
  6,
  208,
  44,
  30,
  143,
  202,
  63,
  15,
  2,
  193,
  175,
  189,
  3,
  1,
  19,
  138,
  107,
  58,
  145,
  17,
  65,
  79,
  103,
  220,
  234,
  151,
  242,
  207,
  206,
  240,
  180,
  230,
  115,
  150,
  172,
  116,
  34,
  231,
  173,
  53,
  133,
  226,
  249,
  55,
  232,
  28,
  117,
  223,
  110,
  71,
  241,
  26,
  113,
  29,
  41,
  197,
  137,
  111,
  183,
  98,
  14,
  170,
  24,
  190,
  27,
  252,
  86,
  62,
  75,
  198,
  210,
  121,
  32,
  154,
  219,
  192,
  254,
  120,
  205,
  90,
  244,
  31,
  221,
  168,
  51,
  136,
  7,
  199,
  49,
  177,
  18,
  16,
  89,
  39,
  128,
  236,
  95,
  96,
  81,
  127,
  169,
  25,
  181,
  74,
  13,
  45,
  229,
  122,
  159,
  147,
  201,
  156,
  239,
  160,
  224,
  59,
  77,
  174,
  42,
  245,
  176,
  200,
  235,
  187,
  60,
  131,
  83,
  153,
  97,
  23,
  43,
  4,
  126,
  186,
  119,
  214,
  38,
  225,
  105,
  20,
  99,
  85,
  33,
  12,
  125
]);
var RCON = new Uint8Array([1, 2, 4, 8, 16, 32, 64, 128, 27, 54]);
function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 128;
    a = a << 1 & 255;
    if (hi) a ^= 27;
    b >>= 1;
  }
  return p;
}
function expandKey(key) {
  const w = new Uint32Array(44);
  for (let i = 0; i < 4; i++) {
    w[i] = key[4 * i] << 24 | key[4 * i + 1] << 16 | key[4 * i + 2] << 8 | key[4 * i + 3];
  }
  for (let i = 4; i < 44; i++) {
    let temp = w[i - 1];
    if (i % 4 === 0) {
      temp = (temp << 8 | temp >>> 24) >>> 0;
      temp = S_BOX[temp >>> 24 & 255] << 24 | S_BOX[temp >>> 16 & 255] << 16 | S_BOX[temp >>> 8 & 255] << 8 | S_BOX[temp & 255];
      temp = (temp ^ RCON[i / 4 - 1] << 24) >>> 0;
    }
    w[i] = (w[i - 4] ^ temp) >>> 0;
  }
  return w;
}
function decryptBlock(block, roundKeys) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = block[i];
  addRoundKey(s, roundKeys, 10);
  for (let round = 9; round >= 1; round--) {
    invShiftRows(s);
    invSubBytes(s);
    addRoundKey(s, roundKeys, round);
    invMixColumns(s);
  }
  invShiftRows(s);
  invSubBytes(s);
  addRoundKey(s, roundKeys, 0);
  return s;
}
function addRoundKey(s, w, round) {
  const base = round * 4;
  for (let c = 0; c < 4; c++) {
    const k = w[base + c];
    s[c * 4] ^= k >>> 24 & 255;
    s[c * 4 + 1] ^= k >>> 16 & 255;
    s[c * 4 + 2] ^= k >>> 8 & 255;
    s[c * 4 + 3] ^= k & 255;
  }
}
function invSubBytes(s) {
  for (let i = 0; i < 16; i++) s[i] = INV_S_BOX[s[i]];
}
function invShiftRows(s) {
  let t = s[13];
  s[13] = s[9];
  s[9] = s[5];
  s[5] = s[1];
  s[1] = t;
  t = s[2];
  s[2] = s[10];
  s[10] = t;
  t = s[6];
  s[6] = s[14];
  s[14] = t;
  t = s[3];
  s[3] = s[7];
  s[7] = s[11];
  s[11] = s[15];
  s[15] = t;
}
function invMixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    s[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}
function aes128EcbDecrypt(data, key) {
  if (key.length !== 16) throw new Error("AES-128 \uD0A4\uB294 16\uBC14\uC774\uD2B8\uC5EC\uC57C \uD569\uB2C8\uB2E4");
  if (data.length % 16 !== 0) throw new Error("AES ECB \uC785\uB825\uC740 16\uBC14\uC774\uD2B8\uC758 \uBC30\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4");
  const roundKeys = expandKey(key);
  const out = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += 16) {
    const block = data.subarray(offset, offset + 16);
    const decrypted = decryptBlock(block, roundKeys);
    out.set(decrypted, offset);
  }
  return out;
}
export {
  aes128EcbDecrypt,
  hmlToLatex,
  hwpEquationToLatex,
  isDisplayMath,
  latexLikeToEqEdit,
  ommlElementToLatex
};
