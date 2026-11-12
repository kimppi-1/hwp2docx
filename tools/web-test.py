# 사이트를 브라우저로 띄워 4개 언어 화면과 변환을 시험한다. 먼저 저장소 폴더에서: python -m http.server 8765
# pip install playwright && playwright install chromium
import asyncio, os
os.makedirs('test-docs/out', exist_ok=True)
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        errs=[]
        for loc in ['ko-KR','en-US','zh-CN','ja-JP','fr-FR']:
            ctx = await b.new_context(locale=loc, viewport={'width':900,'height':1500})
            pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: m.type=='error' and errs.append(m.text))
            await pg.goto('http://localhost:8765/index.html')
            await pg.wait_for_timeout(300)
            lang = await pg.evaluate('document.documentElement.lang')
            print(loc, '->', lang, '|', await pg.title())
            if loc in ('en-US','zh-CN','ja-JP'):
                await pg.set_input_files('#file', ['test-docs/pdf-to-hwpx/견적보고서-워드.pdf', 'test-docs/hwp-to-docx/a.hwp'])
                await pg.wait_for_timeout(4000)
                print('  ', (await pg.inner_text('#results')).replace('\n',' | ')[:400])
                await pg.screenshot(path=f'test-docs/out/lang_{lang}.png', full_page=True)
            await ctx.close()
        # 단추 눌러 바꾸기 + 기억
        ctx = await b.new_context(locale='ko-KR', viewport={'width':390,'height':900})
        pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8765/index.html')
        await pg.click('.langs button[data-lang=ja]')
        print('click ja ->', await pg.evaluate('document.documentElement.lang'), await pg.inner_text('h1'))
        await pg.reload(); print('after reload ->', await pg.evaluate('document.documentElement.lang'))
        await pg.screenshot(path='test-docs/out/lang_mobile_ja.png', full_page=False)
        await pg.click('.langs button[data-lang=ko]'); print('back ko ->', await pg.inner_text('h1'))
        print('errors', errs)
        await b.close()
asyncio.run(main())
