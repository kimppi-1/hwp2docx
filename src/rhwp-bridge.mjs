// rhwp(https://github.com/edwardkim/rhwp, MIT, © Edward Kim) 연결
// 한글 문서를 직접 해석·조판하는 Rust+WebAssembly 엔진. 여기서는 두 가지에 쓴다:
//   · .hwpx 를 읽어 .hwp 로 바꾼 뒤, 기존 한글→워드 변환기에 넘긴다 (.hwpx → 워드)
//   · 우리가 만든 .hwpx 를 .hwp 로도 저장한다 (옛 한글 버전용)
// 엔진 파일이 27MB라 필요할 때 처음 한 번만 받는다 (브라우저: jsDelivr, Node: 설치된 @rhwp/core).
const VERSION = '0.9.0';
const CDN = `https://cdn.jsdelivr.net/npm/@rhwp/core@${VERSION}/`;
let ready = null;

async function load() {
  if (!ready) ready = (async () => {
    const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';
    if (isNode) {
      const [name, nfs, nmod] = ['@rhwp/core', 'node:fs', 'node:module'];   // 묶음(번들)에 들어가지 않게 이름을 변수로
      const m = await import(name);
      const fs = await import(nfs);
      const { createRequire } = await import(nmod);
      const req = createRequire(import.meta.url);
      const wasm = fs.readFileSync(req.resolve('@rhwp/core/rhwp_bg.wasm'));
      await m.default({ module_or_path: wasm });
      return m;
    }
    const url = CDN + 'rhwp.js';
    const m = await import(/* @vite-ignore */ url);
    await m.default({ module_or_path: CDN + 'rhwp_bg.wasm' });
    return m;
  })();
  return ready;
}

// rhwp는 진단 글을 console에 많이 찍는다 → 변환하는 동안만 조용히
async function quiet(fn) {
  const { log, warn, info, debug } = console;
  console.log = console.warn = console.info = console.debug = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, warn, info, debug }); }
}

export async function hwpxToHwpBytes(bytes) {
  const m = await load();
  return quiet(() => {
    const d = new m.HwpDocument(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    try { return d.exportHwp(); } finally { d.free?.(); }
  });
}
export const hwpxToHwp = hwpxToHwpBytes;

// 쪽 그림(SVG) — 미리보기·같음 점수 재기에 쓴다
export async function renderPagesSvg(bytes, max = 50) {
  const m = await load();
  return quiet(() => {
    const d = new m.HwpDocument(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    try { const n = Math.min(max, d.pageCount()); return Array.from({ length: n }, (_, i) => d.renderPageSvg(i)); } finally { d.free?.(); }
  });
}
