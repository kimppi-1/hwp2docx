// 한글 수식 스크립트 → LaTeX
// kordoc(MIT)의 변환기에 넘기기 전에, 한글 수식 편집기에서 흔히 쓰는데 kordoc이 놓치는 표기를 정리한다.
//  - a^3 over b^2: 한글은 첨자가 over보다 먼저 묶인다 → 첨자 대상에 괄호를 씌움
//  - int from 0 to 3 / sum from … to …: 아래·위 끝을 첨자로
//  - SUM·INT·LEFT·RIGHT 같은 대문자 예약어, scale·bold 같은 글꼴 지시어
import { hwpEquationToLatex } from './kordoc-vendor.mjs';

const BIG = 'sum|prod|coprod|int|iint|iiint|oint|odint|otint|bigcup|bigcap|union|inter|bigsqcup|bigoplus|bigotimes|bigodot|lim|Lim';
const UPPER_WORDS = ['UNION', 'INTER', 'SUM', 'PROD', 'INT', 'IINT', 'IIINT', 'OINT', 'LEFT', 'RIGHT', 'LIM', 'SQRT', 'ROOT', 'OVER', 'FROM', 'TO', 'MATRIX', 'PMATRIX', 'BMATRIX', 'DMATRIX', 'CASES'];

// 그룹 하나({…}) 또는 낱말 하나를 읽는다
function operand(s, i) {
  while (s[i] === ' ' || s[i] === '`' || s[i] === '~') i++;
  if (s[i] === '{') {
    let d = 0, j = i;
    for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}' && --d === 0) break; }
    return { text: s.slice(i, j + 1), end: j + 1 };
  }
  const m = /^(?:[A-Za-z]+|[0-9.]+|\\?[^\s{}^_])/.exec(s.slice(i));
  return m ? { text: m[0], end: i + m[0].length } : { text: '', end: i };
}

export function prepHwpEquation(src) {
  let s = String(src || '').replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
  s = s.replace(/\bscale\s+[0-9.]+/gi, ' ').replace(/\b(bold|it|rm)\b/g, ' ');
  for (const w of UPPER_WORDS) s = s.replace(new RegExp(`(?<![A-Za-z])${w}(?![A-Za-z])`, 'g'), w.toLowerCase());
  s = s.replace(/(?<![A-Za-z])union(?![A-Za-z])/g, ' cup ').replace(/(?<![A-Za-z])inter(?![A-Za-z])/g, ' cap ');
  // ^3sqrt{x} (왼쪽 위 첨자로 쓴 거듭제곱근) → root 3 of {x}
  s = s.replace(/\^\s*([0-9A-Za-z])\s*sqrt\b/g, ' root $1 of ');
  // from … to …
  s = s.replace(new RegExp(`\\b(${BIG})\\s+from\\b`, 'g'), (m, op) => `${op} \u0001from`);
  let out = '', i = 0;
  while (i < s.length) {
    const k = s.indexOf('\u0001from', i);
    if (k < 0) { out += s.slice(i); break; }
    out += s.slice(i, k);
    const a = operand(s, k + 5);
    let j = a.end, sup = '';
    const t = /^\s*to\b/.exec(s.slice(j));
    if (t) { const b = operand(s, j + t[0].length); sup = b.text; j = b.end; }
    out += `_{${a.text.replace(/^\{|\}$/g, '')}}` + (sup ? `^{${sup.replace(/^\{|\}$/g, '')}}` : '') + ' ';
    i = j;
  }
  s = out;
  // 첨자 대상 감싸기: x^3 → x^{3}
  let r = '';
  for (let p = 0; p < s.length;) {
    const c = s[p];
    if ((c === '^' || c === '_') && s[p + 1] !== '{') {
      let q = p + 1; while (s[q] === ' ' || s[q] === '`') q++;
      if (s[q] === '{') { r += c; p = q; continue; }
      const m = /^[^\s^_{}()\[\]`~]+/.exec(s.slice(q));
      if (m) { r += `${c}{${m[0]}}`; p = q + m[0].length; continue; }
    }
    r += c; p++;
  }
  r = r.replace(/->/g, ' rarrow ').replace(/<-/g, ' larrow ').replace(/([()])/g, ' $1 ');
  return groupOver(r).replace(/\s+/g, ' ').trim();
}

// 'over' 양쪽의 항(첨자 포함)을 {}로 묶는다: 10a^{3} over b^{2} → {10a^{3}} over {b^{2}}
function matchBack(s, j) { let d = 0; for (let k = j; k >= 0; k--) { if (s[k] === '}') d++; else if (s[k] === '{' && --d === 0) return k; } return -1; }
function matchFwd(s, j) { let d = 0; for (let k = j; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}' && --d === 0) return k; } return s.length - 1; }
function termBack(s, end) {   // end: over 바로 앞 위치(공백 제외 마지막 글자)
  let k = end;
  for (;;) {
    let st;
    if (s[k] === '}') { st = matchBack(s, k); if (st < 0) return end + 1; }
    else if (s[k] === ')') { let d = 0; st = -1; for (let q = k; q >= 0; q--) { if (s[q] === ')') d++; else if (s[q] === '(' && --d === 0) { st = q; break; } } if (st < 0) return end + 1; }
    else { st = k; while (st > 0 && /[A-Za-z0-9.\u0080-\uffff]/.test(s[st - 1]) && !/\s/.test(s[st - 1])) st--; if (!/[A-Za-z0-9.\u0080-\uffff]/.test(s[k])) return end + 1; }
    if (st > 0 && (s[st - 1] === '^' || s[st - 1] === '_')) { k = st - 2; while (k >= 0 && s[k] === ' ') k--; if (k < 0) return st - 1; continue; }
    return st;
  }
}
function termFwd(s, start) {
  let k = start;
  for (;;) {
    let en;
    if (s[k] === '{') en = matchFwd(s, k) + 1;
    else { const m = /^[A-Za-z0-9.\u0080-\uffff]+/.exec(s.slice(k)); if (!m) return start; en = k + m[0].length; }
    if (s[en] === '^' || s[en] === '_') { k = en + 1; continue; }
    return en;
  }
}
function groupOver(s) {
  const re = /(?<![A-Za-z])over(?![A-Za-z])/g;
  let m, guard = 0;
  while ((m = re.exec(s)) && guard++ < 200) {
    let e = m.index - 1; while (e >= 0 && s[e] === ' ') e--;
    let f = m.index + 4; while (f < s.length && s[f] === ' ') f++;
    if (e < 0 || f >= s.length) continue;
    const a = termBack(s, e), b = termFwd(s, f);
    if (a > e || b <= f) continue;
    const left = s.slice(a, e + 1), right = s.slice(f, b);
    const L = /^\{.*\}$/.test(left) && matchFwd(left, 0) === left.length - 1 ? left : `{${left}}`;
    const R = /^\{.*\}$/.test(right) && matchFwd(right, 0) === right.length - 1 ? right : `{${right}}`;
    s = s.slice(0, a) + L + ' over ' + R + s.slice(b);
    re.lastIndex = a + L.length + 6;
  }
  return s;
}

export function hwpEquationLatex(script) {
  return hwpEquationToLatex(prepHwpEquation(script));
}
