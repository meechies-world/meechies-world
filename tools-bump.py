# Run before each commit: stamps ONE build number everywhere it lives, so the stamps can never drift apart:
#   index.html  -> every <script src="js/...?v=">, <meta name="mw-build">
#   version.json -> "build" and "dj"
#   js/dj.js    -> const MW_DJ_BUILD      (stale-tab guardian compares it to version.json "dj")
#   js/app-core.js -> const MW_SHELL_BUILD (background auto-refresh compares it to version.json "build")
# A mismatch between any of these makes open tabs reload themselves (Oct 27 and Oct 31 2026).
import re,time,json
v=str(int(time.time()))
p='index.html'; s=open(p).read()
s=re.sub(r'(<script src="js/[a-z0-9_-]+\.js)\?v=\d+', lambda m:m.group(1)+'?v='+v, s)
if '<meta name="mw-build"' in s: s=re.sub(r'<meta name="mw-build" content="\d+">','<meta name="mw-build" content="%s">'%v,s)
else: s=s.replace('<meta charset="utf-8">','<meta charset="utf-8">\n<meta name="mw-build" content="%s">'%v,1)
open(p,'w').write(s)
open('version.json','w').write(json.dumps({"build":v,"dj":int(v)}))
for f,name in (('js/dj.js','MW_DJ_BUILD'),('js/app-core.js','MW_SHELL_BUILD')):
    t=open(f).read()
    t2=re.sub(r'(const %s = )\d+;'%name, lambda m:m.group(1)+v+';', t, count=1)
    if t2!=t: open(f,'w').write(t2)
print(v)
