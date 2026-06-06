// Vérifie la couche données ajoutée (bands percentiles, ddBands, ruinedFracByTrade) sur une mini-sim.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const numTrades = 150, numSims = 4000, startBalance = 10000, winRate = 0.6, rr = 3.5, risk = 0.005, targetDD = 0.06;
const rand = mulberry32(12345);
const equityByTrade = Array.from({ length: numTrades + 1 }, () => []);
const ddByTrade = Array.from({ length: numTrades + 1 }, () => []);
const tradesToRuin = [];
let ruinCount = 0;
for (let s = 0; s < numSims; s++) {
  let balance = startBalance, peak = startBalance, ruined = false, ruinAt = -1;
  equityByTrade[0].push(startBalance); ddByTrade[0].push(0);
  for (let t = 1; t <= numTrades; t++) {
    const amt = balance * risk;
    balance += rand() < winRate ? amt * rr : -amt;
    if (balance > peak) peak = balance;
    const dd = peak > 0 ? (peak - balance) / peak : 1;
    equityByTrade[t].push(balance);
    ddByTrade[t].push(dd > 1 ? 1 : dd);
    if (!ruined && dd >= targetDD) { ruined = true; ruinAt = t; }
    if (balance <= 0) { for (let k = t + 1; k <= numTrades; k++) { equityByTrade[k].push(0); ddByTrade[k].push(1); } break; }
  }
  if (ruined) { ruinCount++; tradesToRuin.push(ruinAt); }
}
const colPct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
const equityBands = equityByTrade.map((v) => { v.sort((a, b) => a - b); return { p5: colPct(v, 5), p25: colPct(v, 25), p50: colPct(v, 50), p75: colPct(v, 75), p95: colPct(v, 95) }; });
const ddBands = ddByTrade.map((v) => { v.sort((a, b) => a - b); return { p50: colPct(v, 50), p95: colPct(v, 95) }; });
const ruinedCount = new Array(numTrades + 1).fill(0);
tradesToRuin.forEach((ra) => { if (ra >= 0 && ra <= numTrades) ruinedCount[ra]++; });
let cum = 0; const ruinedFrac = ruinedCount.map((c) => { cum += c; return cum / numSims; });

// --- invariants ---
let bandMonoOK = true, ddOK = true, rfMonoOK = true;
for (let t = 0; t <= numTrades; t++) {
  const b = equityBands[t];
  if (!(b.p5 <= b.p25 && b.p25 <= b.p50 && b.p50 <= b.p75 && b.p75 <= b.p95)) bandMonoOK = false;
  const d = ddBands[t];
  if (!(d.p50 >= 0 && d.p50 <= 1 && d.p95 >= d.p50 && d.p95 <= 1)) ddOK = false;
  if (t > 0 && ruinedFrac[t] < ruinedFrac[t - 1] - 1e-12) rfMonoOK = false;
}
console.log("equityBands P5<=P25<=P50<=P75<=P95 :", bandMonoOK ? "OK" : "ECHEC");
console.log("ddBands 0<=P50<=P95<=1            :", ddOK ? "OK" : "ECHEC");
console.log("ruinedFrac monotone croissante    :", rfMonoOK ? "OK" : "ECHEC");
console.log("ruinedFrac[0]                     :", ruinedFrac[0], "(attendu 0)");
console.log("ruinedFrac[final]                 :", ruinedFrac[numTrades].toFixed(4), "vs ruinCount/numSims", (ruinCount / numSims).toFixed(4));
console.log("médiane equity trade 0 / mid / fin:", Math.round(equityBands[0].p50), "/", Math.round(equityBands[75].p50), "/", Math.round(equityBands[numTrades].p50));
console.log("DD médian / pire (P95) au trade 75:", (ddBands[75].p50 * 100).toFixed(1) + "%", "/", (ddBands[75].p95 * 100).toFixed(1) + "%");
