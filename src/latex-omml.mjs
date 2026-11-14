// LaTeX(수식) → 워드 수식(OMML, <m:oMath>)
// 한글 수식 스크립트를 kordoc(MIT)의 변환기로 LaTeX로 바꾼 뒤, 이 파일이 워드 수식 구조로 다시 짓는다.
// 지원: 분수, 근호, 위·아래 첨자, 큰 연산자(∑∫∏…), 괄호 쌍(\left \right), 행렬·경우(cases), 강세(^ ~ ‾ → ·),
//       위·아래 묶음, 함수 이름, \text, 그리스 문자와 각종 기호.

const SYM = {
  // 그리스 문자
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ',
  sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', A: 'Α',
  // 연산·관계
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '⋅', ast: '∗', star: '⋆', circ: '∘', bullet: '∙', bigcirc: '◯',
  oplus: '⊕', ominus: '⊖', otimes: '⊗', oslash: '⊘', odot: '⊙', dagger: '†', ddagger: '‡', dotplus: '∔', uplus: '⊎',
  cap: '∩', cup: '∪', sqcap: '⊓', sqcup: '⊔', land: '∧', wedge: '∧', lor: '∨', vee: '∨', veebar: '⊻', setminus: '∖',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', equiv: '≡', approx: '≈', sim: '∼', simeq: '≃', cong: '≅', asymp: '≍',
  doteq: '≐', fallingdotseq: '≒', risingdotseq: '≓', propto: '∝', ll: '≪', gg: '≫', lll: '⋘', ggg: '⋙', prec: '≺', succ: '≻',
  subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇', nsubseteq: '⊈', sqsubset: '⊏', sqsupset: '⊐', sqsubseteq: '⊑', sqsupseteq: '⊒',
  in: '∈', notin: '∉', ni: '∋', owns: '∋', perp: '⊥', bot: '⊥', top: '⊤', parallel: '∥', mid: '∣', vdash: '⊢', dashv: '⊣', models: '⊨',
  Bumpeq: '≎', frown: '⌢',
  // 화살표
  leftarrow: '←', rightarrow: '→', to: '→', gets: '←', leftrightarrow: '↔', uparrow: '↑', downarrow: '↓', updownarrow: '↕',
  Leftarrow: '⇐', Rightarrow: '⇒', Leftrightarrow: '⇔', Uparrow: '⇑', Downarrow: '⇓', Updownarrow: '⇕', mapsto: '↦',
  nearrow: '↗', searrow: '↘', swarrow: '↙', nwarrow: '↖', hookleftarrow: '↩', hookrightarrow: '↪', longrightarrow: '⟶', longleftarrow: '⟵',
  // 기타
  infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', emptyset: '∅', varnothing: '∅', angle: '∠', measuredangle: '∡',
  sphericalangle: '∢', triangle: '△', square: '□', diamond: '⋄', bigstar: '★', therefore: '∴', because: '∵', prime: '′',
  ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', wp: '℘',
  diagup: '╱', diagdown: '╲', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', langle: '⟨', rangle: '⟩', vert: '|', Vert: '‖',
  '#': '#', '%': '%', '&': '&', '_': '_', '$': '$', '{': '{', '}': '}', '|': '‖',
};
const NARY = {
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', oiint: '∯', oiiint: '∰',
  bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂', bigodot: '⨀', bigsqcup: '⨆', biguplus: '⨄', bigvee: '⋁', bigwedge: '⋀',
};
const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'coth', 'arcsin', 'arccos', 'arctan',
  'log', 'ln', 'lg', 'exp', 'det', 'dim', 'gcd', 'deg', 'arg', 'ker', 'hom', 'Pr', 'mod']);
const LIMFUNCS = new Set(['lim', 'max', 'min', 'sup', 'inf', 'limsup', 'liminf']);
const ACCENT = {
  hat: '̂', widehat: '̂', check: '̌', tilde: '̃', widetilde: '̃', acute: '́', grave: '̀',
  dot: '̇', ddot: '̈', breve: '̆', bar: '̅', vec: '⃗', overrightarrow: '⃗', overleftrightarrow: '⃡',
};
const SPACES = { ',': ' ', ':': ' ', ';': ' ', ' ': ' ', quad: ' ', qquad: '  ', '!': '' };
const MATRIX_DELIM = { matrix: null, pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], cases: ['{', ''] };
const DELIM_CMD = { langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', vert: '|', Vert: '‖', '{': '{', '}': '}', '|': '‖' };

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── 토큰 ──────────────────────────────────────────────────────────────
function tokenize(src) {
  const t = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
      if (!m) { i++; continue; }
      t.push({ k: 'cmd', v: m[1] }); i += m[0].length;
    } else if (/\s/.test(c)) { i++; }
    else if ('{}^_&'.includes(c)) { t.push({ k: c }); i++; }
    else if (c === "'") { t.push({ k: 'ch', v: '′' }); i++; }
    else { const cp = src.codePointAt(i); const ch = String.fromCodePoint(cp); t.push({ k: 'ch', v: ch }); i += ch.length; }
  }
  return t;
}

export function latexToOmml(latex, { rPr = '', display = false } = {}) {
  // 한글 수식의 줄 맞춤 표기(eqalign{# …})와 공백 기호(~ `)를 정리
  const src = String(latex || '')
    .replace(/\\?eqalign\s*\{\s*(?:\\\\)?/g, '{')
    .replace(/~/g, '\\ ').replace(/`/g, '\\,');
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const run = (text, plain = false) => text ? `<m:r>${plain ? '<m:rPr><m:sty m:val="p"/></m:rPr>' : ''}${rPr}<m:t xml:space="preserve">${esc(text)}</m:t></m:r>` : '';
  const e = (x) => `<m:e>${x}</m:e>`;
  const ctrlPr = rPr ? `<m:ctrlPr>${rPr}</m:ctrlPr>` : '';

  // 그룹 글 읽기 ({...} 안의 날 글자: \text, \begin 이름 등)
  function rawGroup() {
    if (peek()?.k !== '{') return '';
    p++; let depth = 1, s = '';
    while (p < toks.length) {
      const k = toks[p++];
      if (k.k === '{') { depth++; s += '{'; }
      else if (k.k === '}') { if (--depth === 0) break; s += '}'; }
      else if (k.k === 'cmd') s += SPACES[k.v] ?? (k.v.length === 1 ? k.v : '\\' + k.v);
      else s += k.v ?? k.k;
    }
    return s;
  }

  // 원소 하나(그룹·명령·글자) → OMML 조각. null = 끝.
  function atom(stop) {
    const k = peek();
    if (!k) return null;
    if (k.k === '}' || k.k === '&') return null;
    if (k.k === 'cmd' && stop && stop.includes(k.v)) return null;
    if (k.k === '{') { p++; const x = seq(['}']); if (peek()?.k === '}') p++; return x; }
    if (k.k === '^' || k.k === '_') return '';     // 밑바탕 없는 첨자
    p++;
    if (k.k === 'ch') {
      // 이어지는 영문/숫자를 한 run으로
      let s = k.v;
      if (/[0-9.]/.test(k.v)) while (peek()?.k === 'ch' && /[0-9.]/.test(peek().v)) s += toks[p++].v;
      return run(s);
    }
    const c = k.v;
    if (c === 'frac' || c === 'dfrac' || c === 'tfrac' || c === 'cfrac') { const a = arg(), b = arg(); return `<m:f><m:fPr>${ctrlPr}</m:fPr><m:num>${a}</m:num><m:den>${b}</m:den></m:f>`; }
    if (c === 'binom') { const a = arg(), b = arg(); return `<m:d><m:dPr>${ctrlPr}</m:dPr>${e(`<m:f><m:fPr><m:type m:val="noBar"/>${ctrlPr}</m:fPr><m:num>${a}</m:num><m:den>${b}</m:den></m:f>`)}</m:d>`; }
    if (c === 'sqrt') {
      let deg = '';
      if (peek()?.k === 'ch' && peek().v === '[') { p++; deg = seq([']']); if (peek()?.v === ']') p++; }
      const body = arg();
      return `<m:rad><m:radPr>${deg ? '' : '<m:degHide m:val="1"/>'}${ctrlPr}</m:radPr><m:deg>${deg}</m:deg>${e(body)}</m:rad>`;
    }
    if (c === 'left') {
      const open = delimChar();
      const body = seq(['right']);
      let close = '';
      if (peek()?.k === 'cmd' && peek().v === 'right') { p++; close = delimChar(); }
      return `<m:d><m:dPr><m:begChr m:val="${esc(open)}"/><m:endChr m:val="${esc(close)}"/>${ctrlPr}</m:dPr>${e(body)}</m:d>`;
    }
    if (c === 'right') return '';
    if (c === 'begin') {
      const env = rawGroup().replace(/\*$/, '');
      if (env === 'array') rawGroup();          // 열 정렬 지정은 버림
      const rows = [[]]; let cell = '';
      for (;;) {
        const n = peek();
        if (!n) break;
        if (n.k === 'cmd' && n.v === 'end') { p++; rawGroup(); break; }
        if (n.k === '&') { p++; rows[rows.length - 1].push(cell); cell = ''; continue; }
        if (n.k === 'cmd' && n.v === '\\') { p++; rows[rows.length - 1].push(cell); cell = ''; rows.push([]); continue; }
        const a = atom(['end', '\\']);
        if (a === null) { if (n.k === '}') { p++; continue; } break; }
        cell += post(a);
      }
      rows[rows.length - 1].push(cell);
      if (rows.length > 1 && rows[rows.length - 1].every(x => !x)) rows.pop();
      const cols = Math.max(...rows.map(r => r.length));
      let x;
      if (env === 'cases' || env === 'aligned' || env === 'align' || env === 'eqalign' || env === 'eqnarray' || env === 'gathered') {
        x = `<m:eqArr><m:eqArrPr>${ctrlPr}</m:eqArrPr>${rows.map(r => e(r.join(env === 'cases' ? run('\u2003\u2003') : ''))).join('')}</m:eqArr>`;
      } else {
        x = `<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="${cols}"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs>${ctrlPr}</m:mPr>`
          + rows.map(r => `<m:mr>${Array.from({ length: cols }, (_, i) => e(r[i] ?? '')).join('')}</m:mr>`).join('') + '</m:m>';
      }
      const d = MATRIX_DELIM[env];
      return d ? `<m:d><m:dPr><m:begChr m:val="${esc(d[0])}"/><m:endChr m:val="${esc(d[1])}"/>${ctrlPr}</m:dPr>${e(x)}</m:d>` : x;
    }
    if (c === 'text' || c === 'mathrm' || c === 'textrm' || c === 'operatorname' || c === 'mbox' || c === 'rm') {
      if (peek()?.k !== '{') return '';
      return run(rawGroup(), true);
    }
    if (c === 'mathbf' || c === 'boldsymbol' || c === 'bf') { const x = arg(); return x.replace(/<m:r>/g, '<m:r><m:rPr><m:sty m:val="b"/></m:rPr>').replace(/<m:rPr><m:sty m:val="b"\/><\/m:rPr><m:rPr>/g, '<m:rPr>'); }
    if (c === 'mathit' || c === 'mathcal' || c === 'mathop' || c === 'mathbb' || c === 'boxed' || c === 'displaystyle' || c === 'Large' || c === 'large') return peek()?.k === '{' ? arg() : '';
    if (c === 'overline') return `<m:bar><m:barPr><m:pos m:val="top"/>${ctrlPr}</m:barPr>${e(arg())}</m:bar>`;
    if (c === 'underline') return `<m:bar><m:barPr><m:pos m:val="bot"/>${ctrlPr}</m:barPr>${e(arg())}</m:bar>`;
    if (ACCENT[c]) return `<m:acc><m:accPr><m:chr m:val="${ACCENT[c]}"/>${ctrlPr}</m:accPr>${e(arg())}</m:acc>`;
    if (c === 'overbrace' || c === 'underbrace') {
      const top = c === 'overbrace';
      return `<m:groupChr><m:groupChrPr><m:chr m:val="${top ? '⏞' : '⏟'}"/><m:pos m:val="${top ? 'top' : 'bot'}"/><m:vertJc m:val="${top ? 'bot' : 'top'}"/>${ctrlPr}</m:groupChrPr>${e(arg())}</m:groupChr>`;
    }
    if (c === 'overset' || c === 'stackrel') { const a = arg(), b = arg(); return `<m:limUpp><m:limUppPr>${ctrlPr}</m:limUppPr>${e(b)}<m:lim>${a}</m:lim></m:limUpp>`; }
    if (c === 'underset') { const a = arg(), b = arg(); return `<m:limLow><m:limLowPr>${ctrlPr}</m:limLowPr>${e(b)}<m:lim>${a}</m:lim></m:limLow>`; }
    if (c === 'tag') { const x = rawGroup(); return run(` (${x})`, true); }
    if (c === 'color' || c === 'textcolor') { rawGroup(); return ''; }
    if (c in SPACES) return run(SPACES[c]);
    if (NARY[c]) return { nary: NARY[c] };
    if (FUNCS.has(c)) return run(c, true);
    if (LIMFUNCS.has(c)) return { lim: c };
    if (SYM[c]) return run(SYM[c]);
    return run(c, true);    // 모르는 명령은 이름을 그대로
  }

  function delimChar() {
    const k = toks[p++];
    if (!k) return '';
    if (k.k === 'ch') return k.v === '.' ? '' : k.v;
    if (k.k === 'cmd') return DELIM_CMD[k.v] ?? SYM[k.v] ?? '';
    if (k.k === '{' || k.k === '}') return k.k;
    return '';
  }

  // 명령의 인수 하나
  function arg() {
    const k = peek();
    if (!k) return '';
    const a = atom();
    return a === null ? '' : post(a);
  }

  // 원소 뒤에 붙는 첨자 처리
  function scripts() {
    let sub = null, sup = null;
    for (let n = 0; n < 2; n++) {
      const k = peek();
      if (k?.k === '_' && sub === null) { p++; sub = arg(); }
      else if (k?.k === '^' && sup === null) { p++; sup = arg(); }
      else break;
    }
    return { sub, sup };
  }
  function post(a) {
    if (a && typeof a === 'object') {
      const { sub, sup } = scripts();
      if (a.nary) {
        const body = peek() && !['}', '&'].includes(peek().k) && !(peek().k === 'cmd' && ['right', '\\', 'end'].includes(peek().v)) ? post(atom() ?? '') : '';
        const isInt = '∫∬∭∮∯∰'.includes(a.nary);
        return `<m:nary><m:naryPr><m:chr m:val="${a.nary}"/><m:limLoc m:val="${isInt ? 'subSup' : 'undOvr'}"/>${sub === null ? '<m:subHide m:val="1"/>' : ''}${sup === null ? '<m:supHide m:val="1"/>' : ''}${ctrlPr}</m:naryPr><m:sub>${sub ?? ''}</m:sub><m:sup>${sup ?? ''}</m:sup>${e(body)}</m:nary>`;
      }
      if (a.lim) {
        const name = run(a.lim, true);
        const fName = sub !== null ? `<m:limLow><m:limLowPr>${ctrlPr}</m:limLowPr>${e(name)}<m:lim>${sub}</m:lim></m:limLow>` : name;
        const x = fName;   // 빈 함수 칸(□)이 생기지 않게 lim 아래 첨자만
        return sup !== null ? `<m:sSup><m:sSupPr>${ctrlPr}</m:sSupPr>${e(x)}<m:sup>${sup}</m:sup></m:sSup>` : x;
      }
      a = '';
    }
    const { sub, sup } = scripts();
    if (sub !== null && sup !== null) return `<m:sSubSup><m:sSubSupPr>${ctrlPr}</m:sSubSupPr>${e(a)}<m:sub>${sub}</m:sub><m:sup>${sup}</m:sup></m:sSubSup>`;
    if (sub !== null) return `<m:sSub><m:sSubPr>${ctrlPr}</m:sSubPr>${e(a)}<m:sub>${sub}</m:sub></m:sSub>`;
    if (sup !== null) return `<m:sSup><m:sSupPr>${ctrlPr}</m:sSupPr>${e(a)}<m:sup>${sup}</m:sup></m:sSup>`;
    return a;
  }

  function seq(stop) {
    let out = '';
    let guard = 0;
    while (p < toks.length && guard++ < 100000) {
      const k = peek();
      if (k.k === '}' && stop?.includes('}')) break;
      if (k.k === 'ch' && stop?.includes(k.v)) break;
      if (k.k === 'cmd' && stop?.includes(k.v)) break;
      if (k.k === '}' || k.k === '&') { p++; continue; }      // 짝 없는 닫는 괄호·열 구분은 버림
      if (k.k === 'cmd' && k.v === '\\') { p++; continue; }
      const a = atom(stop);
      if (a === null) { p++; continue; }
      out += post(a);
    }
    return out;
  }

  const body = seq(null);
  const math = `<m:oMath>${body || run(' ')}</m:oMath>`;
  return display ? `<m:oMathPara>${math}</m:oMathPara>` : math;
}
