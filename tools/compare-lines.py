# 원본 PDF와 결과 PDF(한글·워드로 인쇄한 것)를 줄 단위로 대조한다.
# python tools/compare-lines.py 원본.pdf 결과.pdf
# 쪽수, 같은 쪽에 같은 내용으로 놓인 줄 비율, 글자색 일치, 세로·가로 위치 차이를 보여 준다. (pip install pymupdf)
import pymupdf,sys,statistics,difflib
def L(f):
    out=[]
    for pi,p in enumerate(pymupdf.open(f)):
        for b in p.get_text('dict')['blocks']:
            for l in b.get('lines',[]):
                sp=[s for s in l['spans'] if s['text'].strip()]
                t=''.join(s['text'] for s in l['spans']).replace(' ','')
                if t: out.append((pi,round(sp[0]['origin'][1],1),round(sp[0]['origin'][0],1),t,sp[0]['color']))
    return sorted(out)
def I(f):
    out=[]
    for pi,p in enumerate(pymupdf.open(f)):
        for im in p.get_image_info():
            b=im['bbox']
            if b[2]-b[0]>2 and b[3]-b[1]>2:
                out.append((pi,round(b[1],1),round(b[0],1),round(b[2]-b[0],1),round(b[3]-b[1],1)))
    return sorted(out)
a=L(sys.argv[1]); b=L(sys.argv[2])
ia=I(sys.argv[1]); ib=I(sys.argv[2])
na=len(pymupdf.open(sys.argv[1])); nb=len(pymupdf.open(sys.argv[2]))
sm=difflib.SequenceMatcher(None,[x[3] for x in a],[x[3] for x in b],autojunk=False)
same=0;dy=[];dx=[];col=0;bad=[]
for blk in sm.get_matching_blocks():
    for k in range(blk.size):
        x=a[blk.a+k]; y=b[blk.b+k]
        if x[0]==y[0]:
            same+=1; dy.append(abs(y[1]-x[1])); dx.append(abs(y[2]-x[2])); col+=(x[4]==y[4])
print(f'쪽수 원본 {na} / 한글 {nb}, 줄 {len(a)}/{len(b)}, 같은 쪽·같은 내용 줄 {same} ({same*100//max(1,len(a))}%), 그중 색 같음 {col}')
if dy: print(f'  세로 차이 중앙 {statistics.median(dy):.1f}pt 최대 {max(dy):.1f}, 가로 차이 중앙 {statistics.median(dx):.1f} 최대 {max(dx):.1f}')
if ia or ib:
    used=set(); idy=[]; idx=[]
    for x in ia:
        cand=[(k,y) for k,y in enumerate(ib) if k not in used and y[0]==x[0]]
        if cand:
            k,y=min(cand,key=lambda cy:abs(cy[1][1]-x[1])+abs(cy[1][2]-x[2]))
            used.add(k); idy.append(abs(y[1]-x[1])); idx.append(abs(y[2]-x[2]))
    im_msg=f'  그림 {len(ia)}/{len(ib)}, 같은 쪽 {len(idy)}'
    if idy: im_msg+=f', 세로 차이 중앙 {statistics.median(idy):.1f}pt 최대 {max(idy):.1f}, 가로 차이 중앙 {statistics.median(idx):.1f} 최대 {max(idx):.1f}'
    print(im_msg)
