// PDF → .hwpx (원하면 .docx 도). 결과 이름 = 둘째 인자
// node tools/pdf2hwpx.mjs 문서.pdf 결과/이름 [--docx]
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfToHwpx, pdfToDocx } from '../src/pdf-convert.mjs';
import fs from 'fs';
const [inp, out] = process.argv.slice(2);
const h = await pdfToHwpx(new Uint8Array(fs.readFileSync(inp)), pdfjs); fs.writeFileSync(out + '.hwpx', h.hwpx);
if (process.argv.includes('--docx')) { const d = await pdfToDocx(new Uint8Array(fs.readFileSync(inp)), pdfjs); fs.writeFileSync(out + '.docx', d.docx); }
console.log(JSON.stringify(h.report));
