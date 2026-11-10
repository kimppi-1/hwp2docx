// 웹페이지(index.html)가 쓰는 묶음의 진입점. `npm run build` 로 hwp2docx.bundle.js 를 다시 만든다.
export { hwpToDocx } from './src/index.mjs';
export { HANGUL_ADVANCE, SPACE_ADVANCE } from './src/font-metrics.mjs';
