# MS 워드를 자동으로 움직여 .docx 를 PDF로 저장한다. 결과: 같은 폴더에 "이름(워드).pdf"
#   python tools/render-word.py 결과/*.docx      (pip install pywin32)
import sys, os, glob
import win32com.client as win32

files = [os.path.abspath(f) for a in sys.argv[1:] for f in glob.glob(a)]
word = win32.gencache.EnsureDispatch('Word.Application')
word.Visible = False
for src in files:
    dst = os.path.splitext(src)[0] + '(워드).pdf'
    doc = word.Documents.Open(src, ReadOnly=True)
    doc.SaveAs2(dst, FileFormat=17)   # 17 = PDF
    doc.Close(False)
    print('저장', dst)
word.Quit()
