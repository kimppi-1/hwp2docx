import { parseHwp } from './hwp-parse.mjs';
import { buildDocx } from './docx-write.mjs';
import { readDocx } from './docx-read.mjs';
import { buildHwpx } from './hwpx-write.mjs';

// hwp 파일 내용(Uint8Array) → { docx: Uint8Array, report }
export function hwpToDocx(bytes, opts = {}) {
  const doc = parseHwp(bytes);
  return buildDocx(doc, opts);
}
// docx 파일 내용(Uint8Array) → { hwpx: Uint8Array, report }
export function docxToHwpx(bytes, opts = {}) {
  return buildHwpx(readDocx(bytes), opts);
}
export { parseHwp, buildDocx, readDocx, buildHwpx };
