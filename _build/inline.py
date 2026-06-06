import os
bundle = open("bundle.js", encoding="utf-8").read()
html = """<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Monte Carlo · Ruin — Simulateur de risque de drawdown</title>
<style>
  html,body { margin:0; background:#070a0f; }
  #root { min-height:100vh; }
</style>
</head>
<body><div id="root"></div><script>""" + bundle + """</script></body></html>"""
parent = os.path.dirname(os.getcwd())
targets = [
    os.path.join(parent, "Monte Carlo Ruin.html"),  # version offline
    os.path.join(parent, "_publish", "index.html"),  # version deployee (GitHub Pages)
]
for out in targets:
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w", encoding="utf-8").write(html)
    print("Wrote", out)
