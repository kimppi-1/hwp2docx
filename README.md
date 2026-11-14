# hwp2docx — 한글 ↔ 워드 ↔ PDF 변환기

**HWP to DOCX / DOCX to HWPX / PDF to HWPX** — [English](#english) · [中文](#中文) · [日本語](#日本語)

한글(HWP) 문서는 워드(DOCX)로, 워드 문서는 한글(HWPX)로, PDF는 한글(HWPX)로 바꿉니다. 글꼴, 글자 크기, 색, 자간, 장평, 줄 간격, 여백, 표 모양을 그대로 옮깁니다.

- **쓰는 곳**: https://kimppi-1.github.io/hwp2docx/ (저장소 이름을 다르게 만들었다면 그 이름으로)
- 파일을 끌어다 놓으면 바로 변환됩니다. 설치가 필요 없습니다.
- 화면은 오른쪽 위 단추로 한국어(가)·영어(A)·중국어(中)·일본어(あ)로 바꿀 수 있습니다. 처음에는 브라우저 언어를 따릅니다.
- 변환은 브라우저 안에서 이루어집니다. 파일은 어디에도 올라가지 않습니다.

## 어떻게 맞추나

한글 파일에는 글자·문단·표의 모든 서식 값과, 한글이 실제로 줄을 배치한 결과(줄마다 시작 위치, 높이, 기준선)가 들어 있습니다. 이 값을 읽어 워드의 값으로 환산합니다.

다만 같은 숫자를 한글과 워드가 다르게 그리는 자리가 있어서, 한글이 만든 PDF와 워드가 만든 PDF를 줄 단위로 대조해 아래 규칙을 찾아 넣었습니다 (MS Word LTSC 2021 기준).

| 항목 | 한글 | 워드 | 변환기가 하는 일 |
|---|---|---|---|
| 줄 간격 | 글자 크기의 % | 글꼴마다 다른 줄 높이의 배수 | 한글이 배치한 줄 높이를 '고정' 값으로 넘김 |
| 띄어쓰기 폭 (한글 옆) | 글자 크기의 1/2 | 한글 글자 폭의 절반 | 모자란 만큼 빈칸에 간격을 보탬. 워드가 두 배로 적용하므로 절반만 줌 |
| 띄어쓰기 폭 (영문·숫자·문장부호 사이) | 글자 크기의 1/2 | 글꼴에 든 빈칸 폭 | 모자란 만큼 보탬 |
| 표의 줄 높이 | 안 여백 포함, 테두리는 자리 없음 | 안 여백·테두리를 뺀 안쪽 높이 | 그만큼 빼서 넘김 |
| 글자의 세로 위치 | 줄 위에 붙고 간격은 아래 | 줄 높이의 0.8 지점이 기준선 | 위쪽 여백과 문단 간격으로 옮김 |
| 쪽 나눔 | 쪽 끝에 글자 높이만 들어가면 넣음 | 줄 간격까지 들어가야 넣음 | 한글이 새 쪽을 시작한 문단에 쪽 나눔을 넣어 고정 (끌 수 있음) |
| 체크 상자 ☐☑ | 글꼴에 없으면 함초롬돋움 | 다른 글꼴로 대체 | 함초롬돋움으로 지정 |

세 가지 실제 문서(글 위주 10쪽, 표 중심 2쪽, 표와 글이 섞인 10쪽)에서 쪽수와 각 쪽의 시작·끝이 한글과 같고, 글 위주 문서는 322줄 중 318줄이 같은 자리에서 끊깁니다.

## 워드 → 한글 (.docx → .hwpx)

워드 파일의 스타일 상속, 테마 글꼴, 자동 번호, 표(병합·테두리·배경·안 여백)를 풀어 실제 값을 계산한 뒤 한글 HWPX로 씁니다. HWPX 틀은 한글이 만든 빈 문서를 바탕으로 합니다(아래 '사용한 것').

워드 PDF와 한글 PDF를 줄 단위로 대조해 찾은 규칙:

| 항목 | 워드 | 한글 | 변환기가 하는 일 |
|---|---|---|---|
| '배수' 줄 간격의 한 줄 | 맑은 고딕은 글자 크기의 1.728배 (글꼴 줄 높이 × 1.3) | % 줄 간격은 글자 크기 기준 | 한글 %를 배수 × 1.728 × 100으로 |
| 줄 안의 글자 위치 | 1줄 간격 자리에 두고 늘어난 높이는 글자 아래 | 글자 크기의 0.85 지점, 간격은 아래 | 차이를 문단 위 간격으로 옮김 |
| 문단 사이 간격 | 앞 문단 아래·뒷 문단 위 중 큰 값 ('HTML 문단 자동 간격 사용 안 함'이 켜져 있으면 합) | 둘을 더함 | 큰 값을 뒷 문단 위 간격으로 |
| 띄어쓰기 폭 | 영문 글꼴의 빈칸 폭 (맑은 고딕 0.35) | 글자 크기의 1/2 | 빈칸에 자간. 한글 자간은 빈칸에서는 빈칸 폭에 대한 비율 |
| 표 칸 안 마지막 줄 | 줄 높이 전체 | 글자 높이만, 맨 끝 문단의 아래 간격은 무시 | 차이를 칸 아래쪽 안 여백으로 |
| 표가 쪽 끝에 걸릴 때 | 다음 쪽으로 이어짐 | '글자처럼 취급' 표는 통째로 넘어감 | 문단 기준 '자리 차지' 배치, 셀 단위로 나눔 |
| 표 다음 문단의 위 간격 | 그대로 | 표에 밀려 사라짐 | 표 바깥 아래 여백으로 |
| 문단 배경·테두리 | 글자 부분만 칠함 | 위·아래 문단 간격까지 칠함 | 상자 바깥 간격을 이웃 문단으로 |
| 한글–숫자·영문 사이 | 간격을 넣지 않음 | 자동 간격을 넣음 | 자동 간격 끔 |
| 한글 줄바꿈 | 글자 단위 | 설정값 `KEEP_WORD`일 때 글자 단위 | 모든 문단 글자 단위 |
| 문단 테두리 | 테두리 여백·굵기만큼 문단이 커짐 | 높이에 안 들어감 | 문단 간격으로 옮김 |
| 표 들여쓰기 (워드 2010 이전 호환 모드) | 첫 칸 글자 위치 기준 | 테두리 기준 | 칸 안 여백만큼 뺌 |

세 가지 실제 문서(표와 글이 섞인 6쪽, 표 중심 2쪽, 글 위주 3쪽)에서 쪽수가 워드와 같고, 줄 끝 위치는 394곳 중 392곳이 같습니다.

## 한계

- 워드의 머리말·꼬리말, 암호 걸린 파일, 한글 3.0 이전(.hwp 3.x) 파일, .doc, 카메라 RAW·PSD 파일은 아직 안 됩니다.
- 수식은 한글 수식 스크립트 ↔ 워드 수식(OMML)으로 다시 짓습니다. 분수·근호·첨자·∑∫·괄호·행렬·경우(cases)·강세 기호는 옮기지만, 글꼴 지시(rm·it·bold)와 글자 크기 비율(scale)은 버리고 세세한 간격은 각 프로그램의 수식 조판을 따릅니다. 워드→한글 수식의 크기는 어림값이며 한글이 열 때 다시 그립니다.
- 각주·미주의 번호는 한글처럼 '1)' 모양으로 맞추지만, 번호 모양(로마 숫자 등)·각주 구분선 길이·각주 사이 간격은 각 프로그램의 기본값을 따릅니다.
- 표 캡션은 표 위·아래 문단으로 옮깁니다. 왼쪽·오른쪽 캡션은 표 아래로 옮깁니다.
- 워드 → 한글: 세로로 합친 칸이 쪽 끝에 걸리면 한글은 그 칸 중간에서 나누지 못해 표가 다음 쪽으로 넘어갈 수 있습니다.
- 워드 → 한글의 줄 높이(1.728배)는 맑은 고딕으로만 확인했습니다. 다른 글꼴은 같은 규칙으로 어림한 값입니다.
- 굵은 영문·숫자는 워드가 굵은 글꼴 파일의 폭을, 한글은 보통 글꼴 폭을 써서 조금 다릅니다.
- 문서에 쓰인 글꼴이 워드 파일을 여는 컴퓨터에 없으면 모양이 달라집니다.
- 띄어쓰기 보정 수치는 글꼴마다 재야 합니다. 지금은 함초롬바탕·함초롬돋움·맑은 고딕·굴림·돋움·나눔스퀘어가 들어 있습니다 (`src/font-metrics.mjs`). 그 밖의 글꼴은 보정 없이 넘어갑니다.
- 워드는 양쪽 정렬에서 문장부호 사이 빈칸을 조금 좁혀 한 글자를 더 넣는 일이 있습니다.
- 워드에서 바로 인쇄하면 글자가 한글보다 진하게 나올 수 있습니다. PDF로 저장해 인쇄하면 같습니다.
- 다른 워드 버전, 한컴오피스·구글 문서·LibreOffice에서는 확인하지 않았습니다.

## PDF → 한글 (.pdf → .hwpx)

PDF 안 글자의 자리·크기·글꼴·색·굵기를 읽어 문단을 되살리고, 쪽 크기·여백·줄 간격·정렬·들여쓰기·쪽 나눔을 맞춰 한글 파일로 씁니다. 워드(.docx)로도 바꿀 수 있습니다. PDF 읽기에는 [pdf.js](https://github.com/mozilla/pdf.js)(Apache-2.0)를 씁니다 (`vendor/pdfjs/`).

- 한글에서 저장한 PDF: 줄 끝 빈칸까지 PDF 안에 남아 있어, 문단 글과 글자색·굵기가 원본과 같게 되살아납니다 (PDF와 같은 때 저장한 한글 원본이 있는 문서 2개에서 문단 407개 모두 일치).
- 양쪽 정렬 문서는 오른쪽 끝까지 찬 줄을 이어지는 줄로, 아닌 문서는 다음 줄 첫 낱말이 앞 줄에 들어갈 수 있었는지로 문단을 나눕니다.
- 워드에서 저장한 PDF: 글꼴의 빈칸 폭(맑은 고딕은 글자 크기의 0.35)을 읽어 한글 빈칸 폭에 맞추고, 비스듬히 눕혀 그린 기울임 글자, 표 칸 안의 줄 간격, 오른쪽이 들쭉날쭉한 왼쪽 정렬 문서의 글 폭을 되살립니다. 쪽 나눔은 원본 쪽 아래가 많이 비어 있을 때만 넣고, 꽉 찬 쪽은 자연스럽게 넘어가게 둡니다 (워드 PDF 3개 11쪽에서 줄 88~93%가 같은 쪽·같은 내용).
- 표: PDF에 그려진 표 선과 칸 배경으로 칸을 나누고(합친 칸 포함), 칸마다 테두리·배경색·안 여백·세로 정렬과 글을 되살립니다. 선 없이 배경만 칠한 상자도 한 칸짜리 표로 옮깁니다. 쪽을 넘어 이어지는 표는 하나로 잇고, 다음 쪽에 되풀이된 머리 줄은 한 번만 둡니다.
- 그림·도형·밑줄은 아직 옮기지 않습니다. 배경을 옮기지 못한 흰 글씨는 검정으로 바꿉니다. 스캔한 PDF(글자 없는 그림)는 바꿀 수 없습니다.

```
node cli-pdf.mjs 문서.pdf          # 문서.hwpx
node cli-pdf.mjs 문서.pdf 이름 --docx
```

## 책·문서 사진 → 한글, .hwpx → 워드, .hwp로 받기 (0.7)

- **책 사진 → 한글**: 휴대폰으로 찍은 책 쪽 사진(JPG·PNG·HEIC/HEIF·TIFF·WebP·AVIF·BMP·GIF — 형식은 확장자가 아니라 파일 앞머리로 알아냄, 여러 장이면 파일 이름 순서가 쪽 순서)이나 스캔한 PDF를 넣으면, 종이 네 모서리를 찾아 반듯하게 편 뒤 글자를 읽고(tesseract.js, 한국어+영어 — 헬라어(다성조 그리스어)가 섞인 쪽은 헬라어로 한 번 더 읽어 그 자리만 바꿔 넣음, 헬라어는 Times New Roman 글꼴로. 히브리어가 섞인 쪽은 히브리어로도 읽은 뒤, 스트롱 번호와 읽힌 자음으로 어느 구절인지 찾아 히브리어 성경 본문(WLC, 모음 부호 포함)의 낱말로 바꿔 넣고 오른쪽→왼쪽 읽는 순서로 저장), **판형·여백·글자 크기·줄 간격·자간·줄당 글자 수·쪽당 줄 수·첫 줄 들여쓰기·문단**을 재서 같은 모양의 .hwpx로 만듭니다. 잰 값은 결과 칸에 보여 줍니다.
  - 판형은 사진 비율로 고르거나(신국판·국판 등) 설정에서 직접 고릅니다. 자간은 꽉 찬 줄의 글자가 한글에서도 판면 폭을 정확히 채우도록 계산합니다.
  - 휜 쪽 펴기: 글줄들이 놓인 모양으로 종이가 어떻게 휘었는지(3차 곡면)와 카메라 위치를 계산해 종이를 평평하게 펼친 뒤 읽습니다(거의 평평한 스캔은 그대로).
  - '줄 바뀌는 자리 고정'(기본)에서는 꼬리말·머리말(쪽 번호, 책·장 제목)도 원본 자리·크기대로 넣습니다. 이어진 쪽이면 쪽 번호가 1씩 늘어나도록 잘못 읽은 번호를 바로잡습니다. 이 설정을 끄면 본문에서 뺍니다. 펼친 두 쪽 사진은 왼쪽·오른쪽으로 나눕니다.
  - 작은 글씨(성경 장절 표시 '창세기 32:26', 절 번호)는 크게 키워 다시 읽고, 굵은 제목은 굵게 만듭니다.
  - '줄 바뀌는 자리 고정'을 켜면 줄마다 원본과 같은 글자가 들어갑니다.
  - 한계: 글자는 문자 인식이라 일부 틀릴 수 있고(깨끗한 사진에서 약 98%), 글꼴 이름은 알아내지 못해 함초롬바탕으로 씁니다. 제본 바로 옆처럼 아주 심하게 휜 곳은 덜 펴질 수 있습니다.
  - 코드: `src/photo-read.mjs`(펴기·재기·문단 모델), `src/photo-web.mjs`(브라우저 그림 해독·OCR)
- **.hwpx → 워드**: [rhwp](https://github.com/edwardkim/rhwp)(MIT) 엔진으로 .hwpx를 .hwp로 바꾼 뒤 기존 한글→워드 변환기에 넘깁니다. 공개된 시험용 .hwpx 120개 중 119개 변환(나머지 1개는 일부러 망가뜨린 파일).
- **.hwp로도 받기**: 워드→한글 설정에서 켜면 .hwpx와 함께 .hwp도 만듭니다(옛 한글 버전용).
- rhwp 엔진(약 27MB)은 .hwpx를 넣거나 .hwp 받기를 켰을 때만 jsDelivr에서 한 번 받습니다. 연결 코드는 `src/rhwp-bridge.mjs`.
- 망가진 표(행·열 수가 비정상)도 멈추지 않도록 막았습니다.

## 수식·각주·캡션·배포용 문서 (0.6)

- **수식**: 한글 수식(.hwp의 수식 개체)은 워드 수식으로, 워드 수식은 한글 수식(.hwpx)으로 바뀝니다. 한글 수식 스크립트 ↔ LaTeX 변환은 [kordoc](https://github.com/chrisryugj/kordoc)(MIT)의 변환기를 쓰고(`src/kordoc-vendor.mjs`), 한글 수식에서 흔한 표기(`a^3 over b^2`의 묶음 순서, `int from 0 to 3`, 대문자 `SUM`·`LEFT`, `^3sqrt`)는 `src/hwp-equation.mjs`가 먼저 정리합니다. LaTeX → 워드 수식은 `src/latex-omml.mjs`.
- **각주·미주**: 양쪽 모두 옮깁니다. 본문의 참조 번호와 각주 글 앞 번호를 한글처럼 '1)'로 맞추고, 번호 매기기는 각 프로그램에 맡깁니다. 한글→워드→한글로 왕복해도 ')'가 겹치지 않습니다.
- **표 캡션**: 한글 표의 캡션을 표 위·아래 문단으로 옮깁니다. (전에는 캡션이 있는 표에서 변환이 멈췄습니다.)
- **배포용 문서**: 한글의 '배포용 문서'로 저장된 파일도 본문을 풀어 변환합니다(방식은 kordoc의 것을 따름). 배포용은 작성자가 편집·복사를 막아 둔 문서이니, 변환은 작성자의 뜻을 존중하는 범위에서 써 주세요.
- **튼튼함**: 개체 하나를 읽다 실패해도 문서 전체 변환은 이어 갑니다. 공개된 시험용 HWP 151개(pyhwp, hwp.js, hwp-rs, rhwp)를 모두 변환해 보았고 멈춘 파일은 없습니다(이전 버전은 9개에서 멈춤).

## 다른 앱에서 쓰기

`hwp2docx.bundle.js` 한 파일만 넣으면 (PDF를 바꾸려면 `vendor/pdfjs/`도 함께) 브라우저·Electron 화면에서 전역 `Hwp2Docx`로 쓸 수 있습니다. 모든 변환은 그 컴퓨터 안에서만 이루어집니다.

| 함수 | 넣는 것 | 돌려주는 것 |
|---|---|---|
| `hwpToDocx(bytes, { keepPageBreaks, keepLineBreaks, target })` | .hwp 내용 (Uint8Array) | `{ docx, report }` |
| `docxToHwpx(bytes)` | .docx 내용 | `{ hwpx, report }` |
| `templateFromHwp(bytes)` | 서식 견본 .hwp | 서식 틀 객체 (JSON으로 저장 가능) |
| `styledToHwpx(text, template?)` / `styledToDocx(text, template?)` | 색 표시 글 | .hwpx / .docx 내용 (Uint8Array) |
| `hwpToStyled(bytes)` | .hwp 내용 | 색 표시 글 |
| `await pdfToHwpx(bytes, pdfjs, { cMapUrl })` / `await pdfToDocx(…)` | .pdf 내용, pdf.js 모듈 | `{ hwpx }` / `{ docx }` 와 `report` |

`report`에는 `stats`(문단·표 수), `fonts`(쓰인 글꼴), `approximations`(비슷하게 맞춘 곳 `{ msg, count }`)가 들어 있습니다.

색 표시 글은 한 줄이 한 문단이고, `{파:…}` `{빨:…}` `{초:…}` `{주:…}` 로 글자색을, `{굵:…}` `{파굵:…}` 처럼 굵게를 표시합니다. 서식 틀은 견본 한글 파일 본문에서 가장 많이 쓰인 글꼴·크기·줄 간격·정렬과 쪽 여백을 가져옵니다.

## 고쳐서 올리기

```
npm install
npm run build        # src/ 를 고친 뒤 웹용 묶음(hwp2docx.bundle.js) 다시 만들기
node cli.mjs 문서.hwp        # 한글 → 워드
node cli-docx.mjs 문서.docx  # 워드 → 한글
```

`index.html`, `hwp2docx.bundle.js` 두 파일이 웹페이지의 전부입니다. 저장소에 올리면 주소는 그대로이고 내용만 바뀝니다.

글꼴을 추가하려면 `src/font-metrics.mjs`에 그 글꼴의 한글 글자 폭(`HANGUL_ADVANCE`)과 빈칸 폭(`SPACE_ADVANCE`)을 글자 크기에 대한 비율로 적습니다.

## 라이선스

MIT — 누구나 자유롭게 쓰고, 고치고, 나눌 수 있습니다. `LICENSE` 참고.

## 사용한 것

- `src/hwpx-skeleton.mjs`의 HWPX 기본 틀은 [python-hwpx](https://pypi.org/project/python-hwpx/)의 Skeleton.hwpx에서 가져왔습니다 (Apache License 2.0, Copyright 2025-2026 airmang). `NOTICE` 참고.
- [cfb](https://github.com/SheetJS/js-cfb) (Apache-2.0), [fflate](https://github.com/101arrowz/fflate) (MIT)
- [rhwp](https://github.com/edwardkim/rhwp) @rhwp/core 0.9.0 (MIT, Copyright (c) 2025-2026 Edward Kim) — .hwpx 읽기·.hwp 저장. 저장소에 넣지 않고 쓸 때 jsDelivr에서 받음.
- 휜 책 쪽 펴기(`src/page-dewarp.mjs`): [page_dewarp](https://github.com/mzucker/page_dewarp)(Matt Zucker) · [page-dewarp](https://github.com/lmmx/page-dewarp) · [page-dewarp-js](https://github.com/erykpiast/page-dewarp-js)의 '입체 종이 모형(cubic sheet)' 방식을 OpenCV 없이 다시 짬 (모두 MIT)
- [Open Scriptures Hebrew Bible](https://github.com/openscriptures/morphhb) (CC BY 4.0, 본문은 퍼블릭 도메인 WLC) — 히브리어 성경 본문·스트롱 번호 (vendor/wlc)
- [tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0) — 사진·스캔 글자 인식 (언어 자료 kor·eng·grc·heb는 tessdata, Apache-2.0, 처음 쓸 때 jsDelivr에서 받음)
- [heic-to](https://github.com/hoppergee/heic-to) 1.6.7 (LGPL-3.0, libheif) — 아이폰 HEIC·HEIF 사진 풀기. 고치지 않은 그대로 쓸 때 jsDelivr에서 받음.
- [UTIF.js](https://github.com/photopea/UTIF.js) (utif2, MIT) — TIFF(스캐너) 사진 풀기
- 수식 변환(한글 수식 ↔ LaTeX, 워드 수식 → LaTeX)과 배포용 문서의 AES 복호: [kordoc](https://github.com/chrisryugj/kordoc) 4.24.74 (MIT, Copyright (c) 2026 chrisryugj) — `src/kordoc-vendor.mjs`에 묶어 넣음. 워드 수식 배열(eqArr)을 줄 단위·cases로 읽도록 조금 고침.

---

## English

**HWP to DOCX / DOCX to HWPX / PDF to HWPX** — a converter for Hangul, the Korean word processor by Hancom, that keeps the layout.

- **Use it here**: https://kimppi-1.github.io/hwp2docx/ — drop files onto the page. Nothing to install; the page is available in Korean, English, Chinese and Japanese.
- **Private**: conversion runs entirely in your browser. Files are never uploaded.
- **Hangul (.hwp) → Word (.docx)**: fonts, size, color, letter spacing, character width, line spacing, margins and tables carry over. Line heights and page breaks follow where Hangul actually laid out each line.
- **Word (.docx) → Hangul (.hwpx)**: styles, theme fonts, numbering and tables (merged cells, borders, shading, cell margins) are resolved and written as HWPX. Opens in Hangul 2014 or later.
- **PDF → Hangul (.hwpx)** (or Word): the position, size, font, color and weight of each character are read to rebuild paragraphs, margins, line spacing and page breaks. Tables and colored boxes are rebuilt from the drawn lines and cell shading. PDFs saved from Hangul or Word convert best.
- **Equations, footnotes/endnotes, table captions** carry over in both directions (Hangul equation script ↔ Word OMML, using the converter from [kordoc](https://github.com/chrisryugj/kordoc), MIT). Hangul 'distribution' (read-only) documents can be opened.
- **New in 0.7**: phone photos of book pages (or scanned PDFs) → Hangul with the page size, margins, type size, line spacing, letter spacing and characters per line measured and reproduced; .hwpx → Word and .hwp output via the [rhwp](https://github.com/edwardkim/rhwp) engine (MIT).
- **Not yet supported**: Word headers/footers, password-protected files, HWP 3.x, .doc.
- **In other apps**: include `hwp2docx.bundle.js` (and `vendor/pdfjs/` for PDF) and call `Hwp2Docx.hwpToDocx`, `docxToHwpx`, `pdfToHwpx` or `pdfToDocx` (see the table in "다른 앱에서 쓰기" above).
- **Command line**: `node cli.mjs file.hwp`, `node cli-docx.mjs file.docx`, `node cli-pdf.mjs file.pdf`.
- **License**: MIT.

## 中文

**HWP 转 DOCX / DOCX 转 HWPX / PDF 转 HWPX** — 保留版式的韩国 Hancom「Hangul」文字处理软件文档转换器。

- **在线使用**：https://kimppi-1.github.io/hwp2docx/ ——把文件拖到页面上即可，无需安装。页面支持韩语、英语、中文和日语。
- **隐私**：转换完全在浏览器内完成，文件不会上传。
- Hangul（.hwp）→ Word（.docx）、Word（.docx）→ Hangul（.hwpx）、PDF → Hangul（.hwpx，也可转为 Word）。字体、字号、颜色、字间距、行距、页边距和表格都会原样保留。
- 公式、脚注/尾注、表格标题可双向转换。
- 新增：书页照片（或扫描 PDF）→ Hangul，测量并还原开本、页边距、字号、行距、字距和每行字数；.hwpx → Word，以及输出 .hwp。
- 暂不支持：Word 页眉页脚、加密文件、HWP 3.x、.doc。
- 许可证：MIT。

## 日本語

**HWP→DOCX / DOCX→HWPX / PDF→HWPX** — 韓国 Hancom 社のワープロ「Hangul」の文書を、レイアウトを保ったまま変換するツールです。

- **使う**：https://kimppi-1.github.io/hwp2docx/ — ファイルをページにドロップするだけで、インストールは不要です。画面は韓国語・英語・中国語・日本語に対応しています。
- **プライバシー**：変換はすべてブラウザ内で行われ、ファイルはアップロードされません。
- Hangul（.hwp）→ Word（.docx）、Word（.docx）→ Hangul（.hwpx）、PDF → Hangul（.hwpx、Word にも変換可）。フォント、サイズ、色、字間、行間、余白、表をそのまま移します。
- 数式・脚注/文末脚注・表のキャプションは双方向に変換できます。
- 新機能：本のページの写真（またはスキャン PDF）→ Hangul。判型・余白・文字サイズ・行間・字間・1行の文字数を測って再現します。.hwpx → Word と .hwp 出力にも対応。
- まだ対応していないもの：Word のヘッダー・フッター、パスワード付きファイル、HWP 3.x、.doc。
- ライセンス：MIT。
