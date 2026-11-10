import { parseHwp } from './hwp-parse.mjs';
import { buildDocx } from './docx-write.mjs';

// hwp 파일 내용(Uint8Array) → { docx: Uint8Array, report }
export function hwpToDocx(bytes, opts = {}) {
  const doc = parseHwp(bytes);
  return buildDocx(doc, opts);
}
export { parseHwp, buildDocx };
