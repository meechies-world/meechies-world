# Run before each commit: stamps a build number into index.html, version.json and every script link.
import re,time,json
v=str(int(time.time()))
p='index.html'; s=open(p).read()
s=re.sub(r'(<script src="js/[a-z0-9_-]+\.js)\?v=\d+', lambda m:m.group(1)+'?v='+v, s)
if '<meta name="mw-build"' in s: s=re.sub(r'<meta name="mw-build" content="\d+">','<meta name="mw-build" content="%s">'%v,s)
else: s=s.replace('<meta charset="utf-8">','<meta charset="utf-8">\n<meta name="mw-build" content="%s">'%v,1)
open(p,'w').write(s)
open('version.json','w').write(json.dumps({"build":v}))
print(v)
