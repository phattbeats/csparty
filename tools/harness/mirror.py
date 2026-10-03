import sys,re,os,urllib.request,base64,concurrent.futures as cf,urllib.parse
A=base64.b64encode(b'phatt:WzPyR-fLAH2-2fGgk-kQDo3-ToYtr').decode()
ROOT='https://cloud.example.com'; BASE='/remote.php/dav/files/phatt/cloud/csparty/Half-Life/'
SKIP=re.compile(r'^(valve/(maps|media|overviews)|cstrike/(media|overviews|cl_dlls|dlls))/',re.I)
def req(path,method='GET',depth=None):
    r=urllib.request.Request(ROOT+path,method=method,headers={'User-Agent':'curl/8.5.0','Authorization':'Basic '+A,**({'Depth':depth} if depth else {})})
    return urllib.request.urlopen(r,timeout=120).read()
def walk(rel):
    out=[]; t=req(BASE+urllib.parse.quote(rel),'PROPFIND','1').decode()
    for h in re.findall(r'<d:href>([^<]*)</d:href>',t)[1:]:
        r=urllib.parse.unquote(h.split('Half-Life/',1)[1])
        if SKIP.match(r): continue
        out+= walk(r) if r.endswith('/') else [r]
    return out
files=walk('valve/')+walk('cstrike/')
print(len(files),'files',flush=True)
def get(r):
    d=os.path.join('hlds',r)
    if os.path.exists(d): return
    os.makedirs(os.path.dirname(d),exist_ok=True); b=req(BASE+urllib.parse.quote(r)); open(d,'wb').write(b)
with cf.ThreadPoolExecutor(12) as ex: list(ex.map(get,files))
print('done')
