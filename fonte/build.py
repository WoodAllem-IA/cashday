# Gera ../index.html a partir de fonte/app.html (a mesma página usada na prévia).
import os
here=os.path.dirname(os.path.abspath(__file__))
body=open(os.path.join(here,'app.html'),encoding='utf-8').read()
cut=body.index('</style>')+len('</style>')
head=body[:cut].replace('<meta name="claude:viewport-fit-sides" content="cover">\n','')
doc=f'''<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="CashDay">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#EEF2F0">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" href="icon-192.png">
<style>:root{{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0}}[hidden]{{display:none!important}}</style>
{head}
<script>window.CASHDAY_STANDALONE=true</script>
</head>
<body>{body[cut:]}
</body>
</html>
'''
open(os.path.join(here,'..','index.html'),'w',encoding='utf-8').write(doc)
