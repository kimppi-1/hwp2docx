# 한글(한컴오피스)을 자동으로 움직여 .hwpx/.hwp 를 PDF로 저장한다. 결과: 같은 폴더에 "이름(한글).pdf"
#   python tools/render-hangul.py 결과/*.hwpx
# 준비: pip install pywin32
#   한글 자동화 보안 모듈을 등록하면 파일을 열 때마다 뜨는 '접근 허용' 창이 사라진다.
#   (한컴 개발자 사이트의 FilePathCheckerModule.dll 을 받아 레지스트리
#    HKEY_CURRENT_USER\Software\HNC\HwpAutomation\Modules 에 문자열 값 FilePathCheckerModule = dll 경로 로 등록)
#   등록하지 않았다면 처음 한 번 뜨는 창에서 [모두 허용]을 누른다.
import sys, os, glob, subprocess
import win32com.client as win32

def new_hwp():
    subprocess.run(['taskkill', '/F', '/IM', 'Hwp.exe'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    hwp = win32.gencache.EnsureDispatch('HWPFrame.HwpObject')
    for mod in ('FilePathCheckerModule', 'FilePathCheckerModuleExample'):
        try:
            hwp.RegisterModule('FilePathCheckDLL', mod)
        except Exception:
            pass
    try:
        hwp.SetMessageBoxMode(0x00010000)
    except Exception:
        pass
    return hwp

files = [os.path.abspath(f) for a in sys.argv[1:] for f in glob.glob(a)]
hwpx_files = [f for f in files if f.lower().endswith('.hwpx')]
hwp_jobs = [(f, os.path.splitext(f)[0] + '(한글).pdf', False) for f in files if not f.lower().endswith('.hwpx')]

# 한글 2020은 같은 프로세스에서 HWPX 필터를 불러온 뒤 PDF 저장을 부르면 멈추는 현상이 있으므로,
# 1단계 프로세스에서 .hwpx → 임시 .hwp 로 바꾸고, 새 프로세스에서 임시 .hwp → .pdf 로 저장한다.
if hwpx_files:
    hwp = new_hwp()
    for src in hwpx_files:
        tmp = os.path.splitext(src)[0] + '._tmp.hwp'
        dst = os.path.splitext(src)[0] + '(한글).pdf'
        if not hwp.Open(src, 'HWPX', 'forceopen:true'):
            print('열지 못함', src); continue
        hwp.SaveAs(tmp, 'HWP', '')
        hwp.Clear(1)
        hwp_jobs.append((tmp, dst, True))
    hwp.Quit()
    del hwp

if hwp_jobs:
    hwp = new_hwp()
    for src, dst, is_tmp in hwp_jobs:
        if not hwp.Open(src, 'HWP', 'forceopen:true'):
            print('열지 못함', src); continue
        hwp.SaveAs(dst, 'PDF', '')
        hwp.Clear(1)
        if is_tmp:
            try:
                os.remove(src)
            except OSError:
                pass
        print('저장', dst)
    hwp.Quit()
    del hwp
subprocess.run(['taskkill', '/F', '/IM', 'Hwp.exe'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
