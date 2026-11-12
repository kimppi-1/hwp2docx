// 회귀 시험: 이미 잘 되는 PDF들을 지금 코드로 읽은 결과를 저장(--save)하거나, 저장해 둔 것과 비교한다.
// node tools/snapshot.mjs --save test-docs/pdf-to-hwpx/*.pdf "C:/.../설교/*.pdf"
// node tools/snapshot.mjs        test-docs/pdf-to-hwpx/*.pdf ...
// 결과는 test-docs/baseline/ 에 문서 이름.json 으로 둔다. 다르게 나온 문서는 처음 달라진 문단을 보여 준다.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdf } from '../src/pdf-read.mjs';
import fs from 'fs'; import path from 'path';
const save = process.argv.includes('--save');
const expand = (p) => {
  if (!p.includes('*')) return [p];
  const d = path.dirname(p), pat = new RegExp('^' + path.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => pat.test(f)).map(f => path.join(d, f)) : [];
};
const files = process.argv.slice(2).filter(a => a !== '--save').flatMap(expand);
const dir = path.resolve('test-docs/baseline'); fs.mkdirSync(dir, { recursive: true });
let bad = 0;
for (const f of files) {
  const r = await readPdf(new Uint8Array(fs.readFileSync(f)), pdfjs, { cMapUrl: path.resolve('vendor/pdfjs/cmaps') + '/' });
  const now = JSON.stringify(r.paras, null, 1), base = path.join(dir, path.basename(f) + '.json');
  if (save) { fs.writeFileSync(base, now); console.log('저장', path.basename(f)); continue; }
  if (!fs.existsSync(base)) { console.log('기준 없음', path.basename(f)); continue; }
  const old = fs.readFileSync(base, 'utf8');
  if (old === now) { console.log('같음', path.basename(f)); continue; }
  bad++; const a = JSON.parse(old), b = JSON.parse(now);
  const i = a.findIndex((p, k) => JSON.stringify(p) !== JSON.stringify(b[k]));
  console.log('달라짐', path.basename(f), `문단 ${a.length}→${b.length}, 처음 다른 곳 #${i}`);
  console.log('  전:', JSON.stringify(a[i])?.slice(0, 240)); console.log('  후:', JSON.stringify(b[i])?.slice(0, 240));
}
process.exitCode = bad ? 1 : 0;
