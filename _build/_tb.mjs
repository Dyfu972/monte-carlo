function coefForPnl(pnl, up, down) {
  let c = 1;
  if (pnl >= 0) { for (let i = 0; i < up.length; i++) if (pnl >= up[i].t) c = up[i].c; }
  else { for (let i = 0; i < down.length; i++) if (pnl <= down[i].t) c = down[i].c; }
  return c;
}
function computeBands(fwaUp, fwaDown, upOn, downOn) {
  const isEmpty = (p) => p.t === 0 && p.c === 0;
  const up = (upOn ? fwaUp : []).filter((p) => !isEmpty(p));
  const down = (downOn ? fwaDown : []).filter((p) => !isEmpty(p));
  const upS = up.map((p) => ({ t: p.t / 100, c: p.c })).sort((a, b) => a.t - b.t);
  const downS = down.map((p) => ({ t: p.t / 100, c: p.c })).sort((a, b) => b.t - a.t);
  const coefAt = (pnlPct) => coefForPnl(pnlPct / 100, upS, downS);
  const fmt = (x) => (x >= 0 ? "+" : "") + Math.round(x * 100) / 100 + "%";
  const edges = [...new Set([...up.map((p) => p.t), ...down.map((p) => p.t)])].sort((a, b) => b - a);
  if (!edges.length) return [{ label: "tous niveaux de PnL", coef: 1 }];
  const bands = [{ label: `>= ${fmt(edges[0])}`, coef: coefAt(edges[0] + 1) }];
  for (let i = 0; i < edges.length - 1; i++) bands.push({ label: `${fmt(edges[i + 1])} ... ${fmt(edges[i])}`, coef: coefAt((edges[i] + edges[i + 1]) / 2) });
  bands.push({ label: `<= ${fmt(edges[edges.length - 1])}`, coef: coefAt(edges[edges.length - 1] - 1) });
  return bands;
}
const std = 0.5;
const bands = computeBands([{ t: 2, c: 1.5 }, { t: 0, c: 0 }, { t: 0, c: 0 }], [{ t: 2, c: 1 }, { t: -2, c: 0.5 }, { t: -3, c: 0.25 }], true, true);
console.log("Aperçu pour ta config d'écran :");
for (const b of bands) console.log("  " + b.label.padEnd(16) + " -> x" + b.coef + " = " + (std * b.coef).toFixed(3) + "%");
