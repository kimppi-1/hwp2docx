# 원본과 결과 PDF에서 내용이 다른 줄만 골라 보여 준다 (O=원본, H=결과, 쪽 번호와 y 위치).
# python tools/diff-lines.py 원본.pdf 결과.pdf
import pymupdf,sys,difflib
def L(f):
  out=[]
  for pi,p in enumerate(pymupdf.open(f)):
    for b in p.get_text('dict')['blocks']:
      for l in b.get('lines',[]):
        t=''.join(x['text'] for x in l['spans']).strip()
        t=' '.join(t.split())
        if t: out.append((pi,round(l['bbox'][1]),t))
  return out
a=L(sys.argv[1]); b=L(sys.argv[2])
sa=[x[2] for x in a]; sb=[x[2] for x in b]
sm=difflib.SequenceMatcher(None,sa,sb,autojunk=False)
for op,i1,i2,j1,j2 in sm.get_opcodes():
  if op!='equal':
    print('---',op)
    for x in a[i1:i2][:6]: print('  O',x[0]+1,x[1],x[2][:70])
    for x in b[j1:j2][:6]: print('  H',x[0]+1,x[1],x[2][:70])
