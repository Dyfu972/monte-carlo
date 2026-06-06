import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Risque adaptatif — coefficient de risque selon le PnL cumulé depuis le baseline (Standard).
// up   : paliers de gain   [{ t: fraction, c: coef }] triés ascendant  (+0.12 → +0.24 → +0.36)
// down : paliers de perte  [{ t: fraction négative, c }] triés peu→profond (-0.04 → -0.06 → -0.07)
function coefForPnl(pnl, up, down) {
  let c = 1; // Standard
  if (pnl >= 0) {
    for (let i = 0; i < up.length; i++) if (pnl >= up[i].t) c = up[i].c;
  } else {
    for (let i = 0; i < down.length; i++) if (pnl <= down[i].t) c = down[i].c;
  }
  return c;
}

// Bandes de coefficient résultantes selon le PnL (aperçu live, via le vrai coefForPnl).
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
  const bands = [{ label: `≥ ${fmt(edges[0])}`, coef: coefAt(edges[0] + 1) }];
  for (let i = 0; i < edges.length - 1; i++) {
    bands.push({ label: `${fmt(edges[i + 1])} … ${fmt(edges[i])}`, coef: coefAt((edges[i] + edges[i + 1]) / 2) });
  }
  bands.push({ label: `≤ ${fmt(edges[edges.length - 1])}`, coef: coefAt(edges[edges.length - 1] - 1) });
  return bands;
}

function runSimulations({
  numTrades,
  startBalance,
  winRate, // 0..1
  riskPerTrade, // fraction of balance, e.g. 0.01
  rr, // reward:risk ratio
  targetDD, // fraction, e.g. 0.20
  numSims,
  compounding,
  seed,
  riskMode, // 'flat' | 'fwA'
  fwaUp, // [{ t: fraction, c }] paliers Draw Up (vide si désactivé)
  fwaDown, // [{ t: fraction négative, c }] paliers Draw Down (vide si désactivé)
  fwaRebaseMode, // 'pct' | 'cap' — unité du seuil de ré-évaluation du Standard
  fwaRebaseValue, // seuil de gain (% ou capital) qui remonte le Standard (0 = jamais)
}) {
  const rand = mulberry32(seed >>> 0);
  const ddThreshold = targetDD; // drawdown fraction that counts as "ruin"
  const isEmpty = (p) => p.t === 0 && p.c === 0; // ligne entièrement à zéro = palier inutilisé
  const fwUp = [...(fwaUp || [])].filter((p) => !isEmpty(p)).sort((a, b) => a.t - b.t); // ascendant
  const fwDown = [...(fwaDown || [])].filter((p) => !isEmpty(p)).sort((a, b) => b.t - a.t); // peu→profond

  let ruinCount = 0;
  let tradesToRuin = []; // for runs that ruined
  const finalBalances = [];
  const maxDDs = [];
  let sampleEquity = []; // store equity curves for plotting
  let maxLossStreakG = 0; // worst losing streak across all sims
  let maxWinStreakG = 0; // best winning streak across all sims
  let lossStreakSum = 0; // for avg max loss streak per sim
  let winStreakSum = 0;
  // per-trade equity samples to derive a median equity curve
  const sampleCap = Math.min(numSims, 60); // curves we keep for the chart
  const equityByTrade = Array.from({ length: numTrades + 1 }, () => []);
  const ddByTrade = Array.from({ length: numTrades + 1 }, () => []); // drawdown-depuis-pic par trade (vue underwater)

  // distribution of "trade at which DD threshold first hit"
  const ruinTradeBuckets = {};

  for (let s = 0; s < numSims; s++) {
    let balance = startBalance;
    let baseline = startBalance; // Risque adaptatif : référence PnL (Standard)
    let peak = startBalance;
    let maxDD = 0;
    let ruined = false;
    let ruinAt = -1;
    let curLoss = 0;
    let curWin = 0;
    let simMaxLoss = 0;
    let simMaxWin = 0;
    const equity = s < sampleCap ? [startBalance] : null;
    equityByTrade[0].push(startBalance);
    ddByTrade[0].push(0);

    for (let t = 1; t <= numTrades; t++) {
      // Multiplicateur de risque selon le mode.
      let riskMult = 1;
      if (riskMode === "fwA") {
        // Risque adaptatif : coefficient selon le PnL cumulé depuis le baseline (Standard).
        const pnl = baseline > 0 ? (balance - baseline) / baseline : 0;
        riskMult = coefForPnl(pnl, fwUp, fwDown);
      }
      const baseRisk = compounding ? balance * riskPerTrade : startBalance * riskPerTrade;
      const riskAmt = baseRisk * riskMult;

      // riskAmt === 0 (palier PAUSE) → trade sauté, pas de win/loss.
      if (riskAmt > 0) {
        const win = rand() < winRate;
        balance += win ? riskAmt * rr : -riskAmt;
        if (win) {
          curWin++;
          curLoss = 0;
          if (curWin > simMaxWin) simMaxWin = curWin;
        } else {
          curLoss++;
          curWin = 0;
          if (curLoss > simMaxLoss) simMaxLoss = curLoss;
        }
      }

      if (balance > peak) peak = balance;
      const dd = peak > 0 ? (peak - balance) / peak : 1;
      if (dd > maxDD) maxDD = dd;

      if (equity) equity.push(balance);
      equityByTrade[t].push(balance);
      ddByTrade[t].push(dd > 1 ? 1 : dd);

      // Risque adaptatif : ré-évaluation du Standard (PAUSE ×0 → reprise, ou gain encaissé).
      if (riskMode === "fwA") {
        if (riskMult === 0) {
          baseline = balance;
        } else if (fwaRebaseValue > 0) {
          const gain = balance - baseline;
          const trigger = fwaRebaseMode === "cap" ? fwaRebaseValue : baseline * (fwaRebaseValue / 100);
          if (gain >= trigger) baseline = balance;
        }
      }

      if (!ruined && dd >= ddThreshold) {
        ruined = true;
        ruinAt = t;
      }
      if (balance <= 0) {
        ruined = true;
        if (ruinAt === -1) ruinAt = t;
        if (equity) for (let k = t + 1; k <= numTrades; k++) equity.push(0);
        for (let k = t + 1; k <= numTrades; k++) equityByTrade[k].push(0);
        for (let k = t + 1; k <= numTrades; k++) ddByTrade[k].push(1);
        break;
      }
    }

    if (simMaxLoss > maxLossStreakG) maxLossStreakG = simMaxLoss;
    if (simMaxWin > maxWinStreakG) maxWinStreakG = simMaxWin;
    lossStreakSum += simMaxLoss;
    winStreakSum += simMaxWin;

    if (ruined) {
      ruinCount++;
      tradesToRuin.push(ruinAt);
      const bucket = Math.max(1, Math.ceil((ruinAt / numTrades) * 10));
      ruinTradeBuckets[bucket] = (ruinTradeBuckets[bucket] || 0) + 1;
    }
    finalBalances.push(balance);
    maxDDs.push(maxDD);
    if (equity) sampleEquity.push({ equity, ruined });
  }

  finalBalances.sort((a, b) => a - b);
  maxDDs.sort((a, b) => a - b);
  tradesToRuin.sort((a, b) => a - b);

  const pct = (arr, p) => {
    if (!arr.length) return null;
    const idx = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length));
    return arr[idx];
  };
  const mean = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : 0);

  // Bandes de percentiles par trade : médiane + cône P5–P95 / P25–P75 (vue equity).
  const colPct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const equityBands = equityByTrade.map((vals) => {
    vals.sort((a, b) => a - b);
    return { p5: colPct(vals, 5), p25: colPct(vals, 25), p50: colPct(vals, 50), p75: colPct(vals, 75), p95: colPct(vals, 95) };
  });
  const medianEquity = equityBands.map((b) => b.p50);
  // Bandes de drawdown-depuis-pic par trade (vue underwater) : médiane + pire P95.
  const ddBands = ddByTrade.map((vals) => {
    vals.sort((a, b) => a - b);
    return { p50: colPct(vals, 50), p95: colPct(vals, 95) };
  });
  // Fraction cumulée de trajectoires ruinées (DD ≥ cible) atteinte à chaque trade.
  const ruinedCount = new Array(numTrades + 1).fill(0);
  tradesToRuin.forEach((ra) => { if (ra >= 0 && ra <= numTrades) ruinedCount[ra]++; });
  let cumRuin = 0;
  const ruinedFracByTrade = ruinedCount.map((c) => { cumRuin += c; return cumRuin / numSims; });

  // ---- Strategy statistics (theoretical, per 1R risked) ----
  const p = winRate; // win prob
  const q = 1 - winRate;
  const expectancyR = p * rr - q; // expected R per trade
  const expectancyMoney = expectancyR * (startBalance * riskPerTrade); // $ per trade at base risk
  // Profit factor = gross wins / gross losses (per unit risk over many trades)
  const grossWin = p * rr;
  const grossLoss = q * 1;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  // Kelly fraction for RR payoff: f* = p - q/RR  (fraction of capital to risk)
  const kelly = p - q / rr;

  return {
    ruinProbability: ruinCount / numSims,
    ruinCount,
    numSims,
    tradesToRuinMin: tradesToRuin.length ? tradesToRuin[0] : null,
    tradesToRuinMax: tradesToRuin.length ? tradesToRuin[tradesToRuin.length - 1] : null,
    tradesToRuinMedian: pct(tradesToRuin, 50),
    tradesToRuinMean: tradesToRuin.length ? Math.round(mean(tradesToRuin)) : null,
    finalMean: mean(finalBalances),
    finalMedian: pct(finalBalances, 50),
    finalP5: pct(finalBalances, 5),
    finalP95: pct(finalBalances, 95),
    finalMin: finalBalances[0],
    finalMax: finalBalances[finalBalances.length - 1],
    maxDDmean: mean(maxDDs),
    maxDDmedian: pct(maxDDs, 50),
    maxDDworst: maxDDs[maxDDs.length - 1],
    maxDDp95: pct(maxDDs, 95),
    maxDDbest: maxDDs[0],
    sampleEquity,
    medianEquity,
    equityBands,
    ddBands,
    ruinedFracByTrade,
    // new metrics
    expectancyR,
    expectancyMoney,
    profitFactor,
    kelly,
    maxLossStreak: maxLossStreakG,
    maxWinStreak: maxWinStreakG,
    avgMaxLossStreak: numSims ? lossStreakSum / numSims : 0,
    avgMaxWinStreak: numSims ? winStreakSum / numSims : 0,
    finalReturnMedianPct: ((pct(finalBalances, 50) - startBalance) / startBalance) * 100,
    finalReturnMeanPct: ((mean(finalBalances) - startBalance) / startBalance) * 100,
    startBalance,
    riskPerTrade,
  };
}

// ---------- UI ----------
const ACCENT = "#00ff9c";
const DANGER = "#ff3b6b";
const WARN = "#ffcc4d";
const GRID = "#1c2230";

const fwaInput = {
  width: 46,
  background: "#0d1119",
  border: `1px solid ${GRID}`,
  color: "#e8edf5",
  borderRadius: 6,
  padding: "4px 6px",
  fontFamily: "monospace",
  fontSize: 12,
  textAlign: "center",
};

function Field({ label, children, hint }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: "#7a8499", fontWeight: 600 }}>
        {label}
      </label>
      {children}
      {hint && <span style={{ fontSize: 10, color: "#4f5870" }}>{hint}</span>}
    </div>
  );
}

function Slider({ value, min, max, step, onChange, suffix, accent = ACCENT }) {
  // Saisie directe : champ texte local synchronisé avec la valeur, commit au blur / Entrée.
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  const commit = (raw) => {
    let v = parseFloat(raw);
    if (isNaN(v)) {
      setText(String(value)); // saisie invalide → on rétablit la valeur courante
      return;
    }
    v = Math.min(max, Math.max(min, v)); // borne au [min, max]
    setText(String(v));
    onChange(v);
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: accent, height: 4 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 64, justifyContent: "flex-end" }}>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit(e.target.value);
              e.target.blur();
            }
          }}
          style={{
            width: 54,
            background: "#0d1119",
            border: `1px solid ${GRID}`,
            borderRadius: 6,
            color: accent,
            fontFamily: "monospace",
            fontSize: 14,
            fontWeight: 700,
            textAlign: "right",
            padding: "3px 5px",
            outline: "none",
          }}
        />
        {suffix && <span style={{ fontFamily: "monospace", fontSize: 14, color: accent, fontWeight: 700 }}>{suffix}</span>}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, color = "#e8edf5", big }) {
  return (
    <div
      style={{
        background: "#0d1119",
        border: `1px solid ${GRID}`,
        borderRadius: 10,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span style={{ fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: "#67718a" }}>{label}</span>
      <span style={{ fontFamily: "monospace", fontSize: big ? 30 : 20, fontWeight: 800, color, lineHeight: 1 }}>{value}</span>
      {sub && <span style={{ fontSize: 11, color: "#5b6478" }}>{sub}</span>}
    </div>
  );
}

// Boutons segmentés (toggles du graphe).
function Seg({ options, value, onChange }) {
  return (
    <div style={{ display: "inline-flex", border: `1px solid ${GRID}`, borderRadius: 7, overflow: "hidden" }}>
      {options.map(([val, label]) => (
        <button
          key={val}
          onClick={() => onChange(val)}
          style={{
            background: value === val ? "rgba(0,255,156,0.14)" : "transparent",
            color: value === val ? ACCENT : "#67718a",
            border: "none",
            padding: "5px 11px",
            fontSize: 11,
            fontFamily: "monospace",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Graphe equity / underwater (SVG interactif : crosshair+tooltip, cône de percentiles, échelle log, ligne de ruine).
function EquityChart({ data, startBalance, targetDD, medianEquity, equityBands, ddBands, ruinedFrac, expanded }) {
  const [view, setView] = useState("equity"); // 'equity' | 'underwater'
  const [render, setRender] = useState("cone"); // 'spaghetti' | 'cone' | 'both'
  const [logScale, setLogScale] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);

  const W = expanded ? 1100 : 760;
  const H = expanded ? 560 : 300;
  const pad = { l: 64, r: 18, t: 16, b: 34 };
  const n = medianEquity ? medianEquity.length : data && data.length ? data[0].equity.length : 0;
  if (!n) return null;
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const x = (i) => pad.l + (i / (n - 1)) * plotW;

  // ----- domaine + échelle Y selon la vue -----
  let yOf;
  const gridVals = [];
  let fmtY;
  if (view === "underwater") {
    let ddMax = targetDD || 0.06;
    if (ddBands) ddBands.forEach((b) => { if (b.p95 > ddMax) ddMax = b.p95; });
    ddMax = Math.min(1, ddMax * 1.15) || 0.1;
    yOf = (dd) => pad.t + (dd / ddMax) * plotH; // 0% en haut, ddMax en bas
    const steps = expanded ? 6 : 4;
    for (let i = 0; i <= steps; i++) gridVals.push((i / steps) * ddMax);
    fmtY = (v) => `${(v * 100).toFixed(0)}%`;
  } else {
    let maxV = startBalance;
    let minV = startBalance;
    if (render !== "cone" && data) data.forEach((d) => d.equity.forEach((v) => { if (v > maxV) maxV = v; if (v < minV) minV = v; }));
    if (equityBands) equityBands.forEach((b) => { if (b.p95 > maxV) maxV = b.p95; if (b.p5 < minV) minV = b.p5; });
    if (medianEquity) medianEquity.forEach((v) => { if (v > maxV) maxV = v; if (v < minV) minV = v; });
    if (!logScale) minV = Math.min(minV, 0);
    if (logScale) {
      const lo = Math.max(1, minV <= 0 ? 1 : minV);
      const hi = Math.max(lo * 1.0001, maxV);
      const L = (v) => Math.log10(Math.max(1, v));
      yOf = (v) => pad.t + (1 - (L(v) - L(lo)) / (L(hi) - L(lo) || 1)) * plotH;
      const steps = expanded ? 6 : 4;
      for (let i = 0; i <= steps; i++) gridVals.push(Math.pow(10, L(lo) + (i / steps) * (L(hi) - L(lo))));
    } else {
      const span = maxV - minV || 1;
      yOf = (v) => pad.t + (1 - (v - minV) / span) * plotH;
      const steps = expanded ? 8 : 4;
      for (let i = 0; i <= steps; i++) gridVals.push(minV + (i / steps) * span);
    }
    fmtY = (v) => Math.round(v).toLocaleString();
  }

  // ----- générateurs de chemins -----
  const linePath = (fn) => {
    let d = "";
    for (let i = 0; i < n; i++) d += `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${yOf(fn(i)).toFixed(1)} `;
    return d;
  };
  const areaPath = (loFn, hiFn) => {
    let d = "";
    for (let i = 0; i < n; i++) d += `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${yOf(hiFn(i)).toFixed(1)} `;
    for (let i = n - 1; i >= 0; i--) d += `L ${x(i).toFixed(1)} ${yOf(loFn(i)).toFixed(1)} `;
    return d + "Z";
  };

  // ----- interaction crosshair -----
  const onMove = (e) => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    let idx = Math.round(((vx - pad.l) / plotW) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));
    setHoverIdx(idx);
  };

  const xCount = Math.min(n, expanded ? 11 : 6);
  const legend =
    view === "underwater" ? (
      <span>
        <span style={{ color: WARN }}>━ DD médian</span>
        <span style={{ color: DANGER, marginLeft: 8 }}>━ DD pire (P95)</span>
        <span style={{ color: DANGER, marginLeft: 8 }}>┄ ruine</span>
      </span>
    ) : render === "cone" ? (
      <span>
        <span style={{ color: "#fff" }}>━ médiane</span>
        <span style={{ color: ACCENT, marginLeft: 8 }}>▓ P25–P75 · P5–P95</span>
      </span>
    ) : (
      <span>
        <span style={{ color: ACCENT }}>● survivantes</span>
        <span style={{ color: DANGER, marginLeft: 8 }}>● ruinées</span>
        <span style={{ color: "#fff", marginLeft: 8 }}>━ médiane</span>
      </span>
    );

  return (
    <div>
      {/* barre de contrôle */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Seg options={[["equity", "Equity"], ["underwater", "Underwater"]]} value={view} onChange={setView} />
        {view === "equity" && (
          <>
            <Seg options={[["spaghetti", "Spaghetti"], ["cone", "Cône"], ["both", "Combiné"]]} value={render} onChange={setRender} />
            <button
              onClick={() => setLogScale((s) => !s)}
              style={{
                background: logScale ? "rgba(0,255,156,0.14)" : "transparent",
                color: logScale ? ACCENT : "#67718a",
                border: `1px solid ${GRID}`,
                borderRadius: 7,
                padding: "5px 11px",
                fontSize: 11,
                fontFamily: "monospace",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Log Y
            </button>
          </>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11 }}>{legend}</span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", cursor: "crosshair" }}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* grille horizontale */}
        {gridVals.map((v, i) => {
          const yy = yOf(v);
          return (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={yy} y2={yy} stroke={GRID} strokeWidth="1" />
              <text x={pad.l - 8} y={yy + 4} fontSize={expanded ? 12 : 10} fill="#5b6478" textAnchor="end" fontFamily="monospace">
                {fmtY(v)}
              </text>
            </g>
          );
        })}
        {/* labels X (index de trade) */}
        {xCount > 1 &&
          Array.from({ length: xCount }).map((_, i) => {
            const idx = Math.round((i / (xCount - 1)) * (n - 1));
            return (
              <text key={i} x={x(idx)} y={H - 12} fontSize={expanded ? 12 : 10} fill="#5b6478" textAnchor="middle" fontFamily="monospace">
                {idx}
              </text>
            );
          })}

        {view === "equity" ? (
          <>
            {/* ligne de départ */}
            <line x1={pad.l} x2={W - pad.r} y1={yOf(startBalance)} y2={yOf(startBalance)} stroke="#3a4458" strokeDasharray="4 4" strokeWidth="1" />
            {/* cône de percentiles */}
            {(render === "cone" || render === "both") && equityBands && (
              <>
                <path d={areaPath((i) => equityBands[i].p5, (i) => equityBands[i].p95)} fill={ACCENT} opacity={0.1} stroke="none" />
                <path d={areaPath((i) => equityBands[i].p25, (i) => equityBands[i].p75)} fill={ACCENT} opacity={0.2} stroke="none" />
              </>
            )}
            {/* spaghetti */}
            {(render === "spaghetti" || render === "both") &&
              data &&
              data.map((d, idx) => (
                <path
                  key={idx}
                  d={linePath((i) => d.equity[i])}
                  fill="none"
                  stroke={d.ruined ? DANGER : ACCENT}
                  strokeWidth={1}
                  opacity={d.ruined ? (expanded ? 0.4 : 0.3) : render === "both" ? 0.22 : expanded ? 0.55 : 0.45}
                />
              ))}
            {/* médiane */}
            {medianEquity && <path d={linePath((i) => medianEquity[i])} fill="none" stroke="#ffffff" strokeWidth={expanded ? 3 : 2.2} opacity={0.95} />}
          </>
        ) : (
          <>
            {/* zone + courbe pire cas (P95) */}
            {ddBands && <path d={areaPath(() => 0, (i) => ddBands[i].p95)} fill={DANGER} opacity={0.12} stroke="none" />}
            {ddBands && <path d={linePath((i) => ddBands[i].p95)} fill="none" stroke={DANGER} strokeWidth={1.6} opacity={0.7} />}
            {/* courbe médiane underwater */}
            {ddBands && <path d={linePath((i) => ddBands[i].p50)} fill="none" stroke={WARN} strokeWidth={2} opacity={0.92} />}
            {/* ligne de ruine */}
            <line x1={pad.l} x2={W - pad.r} y1={yOf(targetDD)} y2={yOf(targetDD)} stroke={DANGER} strokeDasharray="5 4" strokeWidth="1.5" />
            <text x={W - pad.r} y={yOf(targetDD) - 5} fontSize={expanded ? 12 : 10} fill={DANGER} textAnchor="end" fontFamily="monospace">
              ruine {(targetDD * 100).toFixed(0)}%
            </text>
          </>
        )}

        {/* crosshair + tooltip */}
        {hoverIdx != null &&
          (() => {
            const hx = x(hoverIdx);
            const rf = ruinedFrac ? `${(ruinedFrac[hoverIdx] * 100).toFixed(1)}%` : "—";
            const rows =
              view === "underwater"
                ? [
                    ["Trade", `#${hoverIdx}`],
                    ["DD médian", ddBands ? `${(ddBands[hoverIdx].p50 * 100).toFixed(1)}%` : "—"],
                    ["DD pire (P95)", ddBands ? `${(ddBands[hoverIdx].p95 * 100).toFixed(1)}%` : "—"],
                    ["Ruinées", rf],
                  ]
                : [
                    ["Trade", `#${hoverIdx}`],
                    ["Médiane", equityBands ? `$${Math.round(equityBands[hoverIdx].p50).toLocaleString()}` : "—"],
                    ["P95", equityBands ? `$${Math.round(equityBands[hoverIdx].p95).toLocaleString()}` : "—"],
                    ["P5", equityBands ? `$${Math.round(equityBands[hoverIdx].p5).toLocaleString()}` : "—"],
                    ["Ruinées", rf],
                  ];
            const boxW = expanded ? 196 : 172;
            const lh = 18;
            const boxH = 16 + rows.length * lh;
            const flip = hx + 14 + boxW > W - pad.r;
            const bx = flip ? hx - 14 - boxW : hx + 14;
            const by = pad.t + 4;
            const markY =
              view === "underwater" ? (ddBands ? yOf(ddBands[hoverIdx].p50) : null) : equityBands ? yOf(equityBands[hoverIdx].p50) : null;
            return (
              <g>
                <line x1={hx} x2={hx} y1={pad.t} y2={H - pad.b} stroke="#8a93a6" strokeWidth="1" strokeDasharray="3 3" opacity={0.7} />
                {markY != null && <circle cx={hx} cy={markY} r={3.2} fill={view === "underwater" ? WARN : "#fff"} />}
                <rect x={bx} y={by} width={boxW} height={boxH} rx={8} fill="#0d1119" stroke={GRID} />
                {rows.map(([k, v], i) => (
                  <g key={i}>
                    <text x={bx + 10} y={by + 14 + i * lh} fontSize={11} fill="#7a8499" fontFamily="monospace">
                      {k}
                    </text>
                    <text x={bx + boxW - 10} y={by + 14 + i * lh} fontSize={11} fill="#e8edf5" fontFamily="monospace" textAnchor="end" fontWeight="700">
                      {v}
                    </text>
                  </g>
                ))}
              </g>
            );
          })()}
      </svg>
    </div>
  );
}

function App() {
  const [numTrades, setNumTrades] = useState(150);
  const [startBalance, setStartBalance] = useState(10000);
  const [winRate, setWinRate] = useState(60);
  const [riskPerTrade, setRiskPerTrade] = useState(0.5);
  const [rr, setRr] = useState(3.5);
  const [targetDD, setTargetDD] = useState(6);
  const [numSims, setNumSims] = useState(10000);
  const [compounding, setCompounding] = useState(true);
  const [riskMode, setRiskMode] = useState("fwA"); // 'flat' | 'fwA'
  const [fwaUp, setFwaUp] = useState([{ t: 2, c: 1.5 }, { t: 0, c: 0 }, { t: 0, c: 0 }]); // Draw Up (lignes vides = inactif)
  const [fwaDown, setFwaDown] = useState([{ t: -1.5, c: 0.5 }, { t: -2, c: 0.25 }, { t: 0, c: 0 }]); // Draw Down (3e ligne vide = inactif)
  const [fwaUpOn, setFwaUpOn] = useState(true); // activer le Draw Up
  const [fwaDownOn, setFwaDownOn] = useState(true); // activer le Draw Down
  const [fwaRebaseMode, setFwaRebaseMode] = useState("pct"); // 'pct' | 'cap'
  const [fwaRebaseValue, setFwaRebaseValue] = useState(0); // seuil de gain qui remonte le Standard (0 = jamais)
  const [seed, setSeed] = useState(12345);
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [expandedChart, setExpandedChart] = useState(false);

  const run = useCallback(() => {
    setRunning(true);
    setTimeout(() => {
      const r = runSimulations({
        numTrades,
        startBalance,
        winRate: winRate / 100,
        riskPerTrade: riskPerTrade / 100,
        rr,
        targetDD: targetDD / 100,
        numSims,
        compounding,
        seed,
        riskMode,
        fwaUp: fwaUpOn ? fwaUp.map((row) => ({ t: row.t / 100, c: row.c })) : [],
        fwaDown: fwaDownOn ? fwaDown.map((row) => ({ t: row.t / 100, c: row.c })) : [],
        fwaRebaseMode,
        fwaRebaseValue,
      });
      setResults(r);
      setRunning(false);
    }, 30);
  }, [numTrades, startBalance, winRate, riskPerTrade, rr, targetDD, numSims, compounding, seed, riskMode, fwaUp, fwaDown, fwaUpOn, fwaDownOn, fwaRebaseMode, fwaRebaseValue]);

  const fwaBands = useMemo(() => computeBands(fwaUp, fwaDown, fwaUpOn, fwaDownOn), [fwaUp, fwaDown, fwaUpOn, fwaDownOn]);

  const expectancy = winRate / 100 * rr - (1 - winRate / 100);
  const edgePositive = expectancy > 0;

  const ruinColor = (p) => (p > 0.5 ? DANGER : p > 0.2 ? WARN : ACCENT);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at 20% 0%, #11161f 0%, #070a0f 60%)",
        color: "#e8edf5",
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        padding: "28px 20px 60px",
      }}
    >
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Syne:wght@700;800&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 6, flexWrap: "wrap" }}>
          <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: 34, fontWeight: 800, margin: 0, letterSpacing: -1, color: "#fff" }}>
            MONTE CARLO<span style={{ color: ACCENT }}>·</span>RUIN
          </h1>
          <span style={{ fontSize: 12, color: "#67718a", letterSpacing: 1 }}>
            Simulateur de trajectoires & risque de drawdown
          </span>
        </div>
        <div style={{ height: 1, background: `linear-gradient(90deg, ${ACCENT}, transparent)`, marginBottom: 24, opacity: 0.4 }} />

        <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 360px) 1fr", gap: 24, alignItems: "start" }}>
          {/* ---------- Controls ---------- */}
          <div
            style={{
              background: "#0a0e15",
              border: `1px solid ${GRID}`,
              borderRadius: 14,
              padding: 22,
              display: "flex",
              flexDirection: "column",
              gap: 18,
              position: "sticky",
              top: 20,
            }}
          >
            <Field label="Nombre de trades">
              <Slider value={numTrades} min={10} max={1000} step={10} onChange={setNumTrades} suffix="" />
            </Field>

            <Field label="Balance de départ" hint="capital initial">
              <input
                type="number"
                value={startBalance}
                onChange={(e) => setStartBalance(Math.max(1, parseFloat(e.target.value) || 0))}
                style={{
                  background: "#0d1119",
                  border: `1px solid ${GRID}`,
                  color: ACCENT,
                  borderRadius: 8,
                  padding: "10px 12px",
                  fontFamily: "monospace",
                  fontSize: 15,
                  fontWeight: 700,
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
            </Field>

            <Field label="Win rate">
              <Slider value={winRate} min={1} max={99} step={1} onChange={setWinRate} suffix="%" />
            </Field>

            <Field label="Risk per trade" hint="% de la balance par trade">
              <Slider value={riskPerTrade} min={0.1} max={10} step={0.05} onChange={setRiskPerTrade} suffix="%" accent={WARN} />
            </Field>

            <Field label="Risk : Reward ratio" hint="gain = risque × RR">
              <Slider value={rr} min={0.2} max={10} step={0.1} onChange={setRr} suffix=":1" />
            </Field>

            <Field label="Drawdown cible (ruine)" hint="seuil considéré comme échec">
              <Slider value={targetDD} min={2} max={90} step={1} onChange={setTargetDD} suffix="%" accent={DANGER} />
            </Field>

            <Field label="Nombre de simulations">
              <Slider value={numSims} min={200} max={10000} step={200} onChange={setNumSims} suffix="" />
            </Field>

            {/* Mode de gestion du risque */}
            <Field label="Mode de gestion du risque" hint="comment le risque évolue selon ton equity">
              <div style={{ display: "flex", gap: 6 }}>
                {[
                  ["flat", "Fixe"],
                  ["fwA", "Risque adaptatif"],
                ].map(([m, lbl]) => (
                  <button
                    key={m}
                    onClick={() => setRiskMode(m)}
                    style={{
                      flex: 1,
                      background: riskMode === m ? "rgba(255,204,77,0.12)" : "#0d1119",
                      border: `1px solid ${riskMode === m ? WARN : GRID}`,
                      color: riskMode === m ? WARN : "#67718a",
                      borderRadius: 8,
                      padding: "9px 4px",
                      fontSize: 11,
                      fontFamily: "monospace",
                      fontWeight: 700,
                      cursor: "pointer",
                      letterSpacing: 0.5,
                    }}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </Field>

            {/* Panneau Risque adaptatif (paliers de PnL cumulé) */}
            {riskMode === "fwA" && (
              <div
                style={{
                  background: "rgba(0,255,156,0.05)",
                  border: `1px solid rgba(0,255,156,0.35)`,
                  borderRadius: 10,
                  padding: "14px 14px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div style={{ fontSize: 11, color: ACCENT, fontWeight: 700, letterSpacing: 1 }}>
                  RISQUE ADAPTATIF — paliers de PnL cumulé
                </div>
                <div style={{ fontSize: 10, color: "#8a93a6", lineHeight: 1.5 }}>
                  Risque/trade = <b>Risque Standard ({riskPerTrade}%)</b> × coefficient du palier. Le PnL est mesuré
                  depuis le « Standard », ré-évalué périodiquement.
                </div>

                <button
                  onClick={() => setFwaUpOn((v) => !v)}
                  style={{ background: "transparent", border: "none", color: fwaUpOn ? ACCENT : "#4f5870", fontSize: 10, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1, cursor: "pointer", textAlign: "left", padding: 0 }}
                >
                  {fwaUpOn ? "☑ ▲ DRAW UP (profit)" : "☐ ▲ DRAW UP (désactivé → ×1)"}
                </button>
                {fwaUpOn && fwaUp.map((row, i) => (
                  <div key={`u${i}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, color: "#67718a", minWidth: 64 }}>Draw Up {i + 1}</span>
                    <span style={{ fontSize: 10, color: "#67718a" }}>≥</span>
                    <input
                      type="number"
                      value={row.t}
                      onChange={(e) => setFwaUp(fwaUp.map((r, j) => (j === i ? { ...r, t: parseFloat(e.target.value) || 0 } : r)))}
                      style={fwaInput}
                    />
                    <span style={{ fontSize: 10, color: "#67718a" }}>% ×</span>
                    <input
                      type="number"
                      value={row.c}
                      onChange={(e) => setFwaUp(fwaUp.map((r, j) => (j === i ? { ...r, c: parseFloat(e.target.value) || 0 } : r)))}
                      style={fwaInput}
                    />
                    <span style={{ fontSize: 10, color: row.t === 0 && row.c === 0 ? "#4f5870" : row.c === 0 ? DANGER : ACCENT, minWidth: 48, textAlign: "right" }}>
                      {row.t === 0 && row.c === 0 ? "inactif" : row.c === 0 ? "PAUSE" : `= ${(riskPerTrade * row.c).toFixed(2)}%`}
                    </span>
                  </div>
                ))}

                <div style={{ display: "flex", alignItems: "center", gap: 6, opacity: 0.75 }}>
                  <span style={{ fontSize: 10, color: "#8a93a6", minWidth: 64 }}>Standard</span>
                  <span style={{ fontSize: 10, color: "#8a93a6" }}>0 % → ×1 = {riskPerTrade}%</span>
                </div>

                <button
                  onClick={() => setFwaDownOn((v) => !v)}
                  style={{ background: "transparent", border: "none", color: fwaDownOn ? DANGER : "#4f5870", fontSize: 10, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1, cursor: "pointer", textAlign: "left", padding: 0 }}
                >
                  {fwaDownOn ? "☑ ▼ DRAW DOWN (protection)" : "☐ ▼ DRAW DOWN (désactivé → ×1)"}
                </button>
                {fwaDownOn && fwaDown.map((row, i) => (
                  <div key={`d${i}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, color: "#67718a", minWidth: 64 }}>Draw Down {i + 1}</span>
                    <span style={{ fontSize: 10, color: "#67718a" }}>≤</span>
                    <input
                      type="number"
                      value={row.t}
                      onChange={(e) => setFwaDown(fwaDown.map((r, j) => (j === i ? { ...r, t: parseFloat(e.target.value) || 0 } : r)))}
                      style={fwaInput}
                    />
                    <span style={{ fontSize: 10, color: "#67718a" }}>% ×</span>
                    <input
                      type="number"
                      value={row.c}
                      onChange={(e) => setFwaDown(fwaDown.map((r, j) => (j === i ? { ...r, c: parseFloat(e.target.value) || 0 } : r)))}
                      style={fwaInput}
                    />
                    <span style={{ fontSize: 10, color: row.t === 0 && row.c === 0 ? "#4f5870" : row.c === 0 ? DANGER : WARN, minWidth: 48, textAlign: "right" }}>
                      {row.t === 0 && row.c === 0 ? "inactif" : row.c === 0 ? "PAUSE" : `= ${(riskPerTrade * row.c).toFixed(2)}%`}
                    </span>
                  </div>
                ))}

                <Field label="Remonter le Standard" hint="quand le gain depuis le Standard atteint ce seuil, le Standard remonte (0 = jamais)">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ display: "flex", gap: 4 }}>
                      {[
                        ["pct", "%"],
                        ["cap", "Capital"],
                      ].map(([m, lbl]) => (
                        <button
                          key={m}
                          onClick={() => setFwaRebaseMode(m)}
                          style={{
                            background: fwaRebaseMode === m ? "rgba(0,255,156,0.14)" : "#0d1119",
                            border: `1px solid ${fwaRebaseMode === m ? ACCENT : GRID}`,
                            color: fwaRebaseMode === m ? ACCENT : "#67718a",
                            borderRadius: 6,
                            padding: "5px 8px",
                            fontSize: 10,
                            fontFamily: "monospace",
                            fontWeight: 700,
                            cursor: "pointer",
                          }}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                    <input
                      type="number"
                      value={fwaRebaseValue}
                      onChange={(e) => setFwaRebaseValue(Math.max(0, parseFloat(e.target.value) || 0))}
                      style={{ ...fwaInput, width: 80, flex: 1, textAlign: "right" }}
                    />
                    <span style={{ fontSize: 12, color: ACCENT, fontFamily: "monospace", fontWeight: 700, minWidth: 14 }}>
                      {fwaRebaseMode === "pct" ? "%" : "$"}
                    </span>
                  </div>
                </Field>

                {/* Aperçu : risque résultant selon le PnL */}
                <div style={{ borderTop: `1px solid ${GRID}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
                  <div style={{ fontSize: 10, color: "#67718a", letterSpacing: 1, fontWeight: 700 }}>📊 RISQUE RÉSULTANT SELON TON PnL</div>
                  {fwaBands.map((b, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10 }}>
                      <span style={{ color: "#8a93a6", fontFamily: "monospace" }}>{b.label}</span>
                      <span style={{ fontFamily: "monospace", fontWeight: 700, color: b.coef === 0 ? DANGER : b.coef > 1 ? ACCENT : b.coef < 1 ? WARN : "#e8edf5" }}>
                        {b.coef === 0 ? "PAUSE" : `×${b.coef} = ${(riskPerTrade * b.coef).toFixed(3)}%`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button
                onClick={() => setCompounding((c) => !c)}
                style={{
                  flex: 1,
                  background: compounding ? "rgba(0,255,156,0.12)" : "#0d1119",
                  border: `1px solid ${compounding ? ACCENT : GRID}`,
                  color: compounding ? ACCENT : "#67718a",
                  borderRadius: 8,
                  padding: "9px",
                  fontSize: 11,
                  fontFamily: "monospace",
                  fontWeight: 700,
                  cursor: "pointer",
                  letterSpacing: 1,
                }}
              >
                {compounding ? "● COMPOUNDING" : "○ FIXED RISK"}
              </button>
              <input
                type="number"
                value={seed}
                onChange={(e) => setSeed(parseInt(e.target.value) || 0)}
                title="seed (reproductibilité)"
                style={{
                  width: 80,
                  background: "#0d1119",
                  border: `1px solid ${GRID}`,
                  color: "#67718a",
                  borderRadius: 8,
                  padding: "9px",
                  fontFamily: "monospace",
                  fontSize: 12,
                  boxSizing: "border-box",
                }}
              />
            </div>

            {/* Edge readout */}
            <div
              style={{
                background: edgePositive ? "rgba(0,255,156,0.06)" : "rgba(255,59,107,0.06)",
                border: `1px solid ${edgePositive ? "rgba(0,255,156,0.3)" : "rgba(255,59,107,0.3)"}`,
                borderRadius: 8,
                padding: "10px 12px",
              }}
            >
              <div style={{ fontSize: 10, color: "#67718a", letterSpacing: 1, marginBottom: 2 }}>EXPECTANCE / TRADE</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: edgePositive ? ACCENT : DANGER }}>
                {expectancy >= 0 ? "+" : ""}
                {expectancy.toFixed(3)} R {edgePositive ? "✓ edge positif" : "✗ edge négatif"}
              </div>
            </div>

            <button
              onClick={run}
              disabled={running}
              style={{
                background: ACCENT,
                color: "#04120c",
                border: "none",
                borderRadius: 10,
                padding: "14px",
                fontSize: 14,
                fontWeight: 800,
                fontFamily: "monospace",
                letterSpacing: 2,
                cursor: running ? "wait" : "pointer",
                boxShadow: `0 0 24px rgba(0,255,156,0.35)`,
              }}
            >
              {running ? "SIMULATION..." : "▶ LANCER LA SIMULATION"}
            </button>
          </div>

          {/* ---------- Results ---------- */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {!results ? (
              <div
                style={{
                  border: `1px dashed ${GRID}`,
                  borderRadius: 14,
                  padding: 60,
                  textAlign: "center",
                  color: "#4f5870",
                  fontSize: 14,
                }}
              >
                Configure tes paramètres et lance la simulation.<br />
                <span style={{ fontSize: 12 }}>
                  Chaque run simule {numSims.toLocaleString()} trajectoires de {numTrades} trades.
                </span>
              </div>
            ) : (
              <>
                {/* Headline ruin probability */}
                <div
                  style={{
                    background: "#0a0e15",
                    border: `1px solid ${ruinColor(results.ruinProbability)}`,
                    borderRadius: 14,
                    padding: 22,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 16,
                    boxShadow: `0 0 30px ${ruinColor(results.ruinProbability)}22`,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 11, color: "#67718a", letterSpacing: 1.5, textTransform: "uppercase" }}>
                      Risque d'atteindre {targetDD}% de drawdown
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 52, fontWeight: 800, color: ruinColor(results.ruinProbability), lineHeight: 1 }}>
                      {(results.ruinProbability * 100).toFixed(1)}%
                    </div>
                    <div style={{ fontSize: 12, color: "#67718a" }}>
                      {results.ruinCount.toLocaleString()} / {results.numSims.toLocaleString()} trajectoires ruinées
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 11, color: "#67718a", letterSpacing: 1, textTransform: "uppercase" }}>Verdict</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: ruinColor(results.ruinProbability) }}>
                      {results.ruinProbability > 0.5
                        ? "TRÈS RISQUÉ"
                        : results.ruinProbability > 0.2
                        ? "PRUDENCE"
                        : results.ruinProbability > 0.05
                        ? "ACCEPTABLE"
                        : "ROBUSTE"}
                    </div>
                  </div>
                </div>

                {/* Trades-to-ruin grid */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                  <Stat
                    label="Ruine la + rapide"
                    value={results.tradesToRuinMin ?? "—"}
                    sub={results.tradesToRuinMin ? "trades avant seuil" : "jamais atteint"}
                    color={DANGER}
                  />
                  <Stat
                    label="Ruine médiane"
                    value={results.tradesToRuinMedian ?? "—"}
                    sub="trades (médiane)"
                    color={WARN}
                  />
                  <Stat
                    label="Ruine la + lente"
                    value={results.tradesToRuinMax ?? "—"}
                    sub="trades avant seuil"
                    color="#e8edf5"
                  />
                  <Stat label="Ruine moyenne" value={results.tradesToRuinMean ?? "—"} sub="trades (moyenne)" color="#e8edf5" />
                </div>

                {/* Strategy statistics */}
                <div>
                  <div style={{ fontSize: 11, color: "#67718a", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 }}>
                    Statistiques de stratégie
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                    <Stat
                      label="Espérance math."
                      value={`${results.expectancyR >= 0 ? "+" : ""}${results.expectancyR.toFixed(3)} R`}
                      sub={`${results.expectancyMoney >= 0 ? "+" : ""}$${results.expectancyMoney.toFixed(2)} / trade`}
                      color={results.expectancyR >= 0 ? ACCENT : DANGER}
                    />
                    <Stat
                      label="Profit factor"
                      value={isFinite(results.profitFactor) ? results.profitFactor.toFixed(2) : "∞"}
                      sub={results.profitFactor >= 1 ? "rentable" : "perdant"}
                      color={results.profitFactor >= 1.5 ? ACCENT : results.profitFactor >= 1 ? WARN : DANGER}
                    />
                    <Stat
                      label="Risque optimal (Kelly)"
                      value={`${(results.kelly * 100).toFixed(2)}%`}
                      sub={
                        results.kelly <= 0
                          ? "edge négatif → ne pas trader"
                          : `½ Kelly conseillé : ${(results.kelly * 50).toFixed(2)}%`
                      }
                      color={results.kelly <= 0 ? DANGER : riskPerTrade / 100 > results.kelly ? WARN : ACCENT}
                    />
                    <Stat
                      label="Rendement final médian"
                      value={`${results.finalReturnMedianPct >= 0 ? "+" : ""}${results.finalReturnMedianPct.toFixed(1)}%`}
                      sub={`moyen ${results.finalReturnMeanPct >= 0 ? "+" : ""}${results.finalReturnMeanPct.toFixed(1)}%`}
                      color={results.finalReturnMedianPct >= 0 ? ACCENT : DANGER}
                    />
                  </div>
                </div>

                {/* Streaks */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                  <Stat
                    label="Série de pertes max"
                    value={`${results.maxLossStreak} ✗`}
                    sub={`moy. ${results.avgMaxLossStreak.toFixed(1)} par run`}
                    color={DANGER}
                  />
                  <Stat
                    label="Série de gains max"
                    value={`${results.maxWinStreak} ✓`}
                    sub={`moy. ${results.avgMaxWinStreak.toFixed(1)} par run`}
                    color={ACCENT}
                  />
                  <Stat
                    label="Probabilité de ruine"
                    value={`${(results.ruinProbability * 100).toFixed(1)}%`}
                    sub={`seuil ${targetDD}% DD`}
                    color={ruinColor(results.ruinProbability)}
                  />
                  <Stat
                    label="Trades avant ruine (méd.)"
                    value={results.tradesToRuinMedian ?? "—"}
                    sub={results.tradesToRuinMedian ? "trades" : "jamais atteint"}
                    color={WARN}
                  />
                </div>

                {/* Drawdown stats */}
                <div>
                  <div style={{ fontSize: 11, color: "#67718a", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 }}>
                    Drawdown maximum
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                    <Stat label="Probable (P95)" value={`${(results.maxDDp95 * 100).toFixed(1)}%`} sub="95% des cas en-dessous" color={DANGER} />
                    <Stat label="Pire cas observé" value={`${(results.maxDDworst * 100).toFixed(1)}%`} color={DANGER} />
                    <Stat label="Médian" value={`${(results.maxDDmedian * 100).toFixed(1)}%`} color={WARN} />
                    <Stat label="Moyen" value={`${(results.maxDDmean * 100).toFixed(1)}%`} color="#e8edf5" />
                  </div>
                </div>

                {/* Equity chart */}
                <div style={{ background: "#0a0e15", border: `1px solid ${GRID}`, borderRadius: 14, padding: "18px 18px 8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "#67718a", letterSpacing: 1.5, textTransform: "uppercase" }}>
                      Trajectoires d'equity (échantillon de {results.sampleEquity.length})
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                      <button
                        onClick={() => setExpandedChart(true)}
                        style={{
                          background: "rgba(0,255,156,0.1)",
                          border: `1px solid ${ACCENT}`,
                          color: ACCENT,
                          borderRadius: 7,
                          padding: "5px 10px",
                          fontSize: 11,
                          fontFamily: "monospace",
                          fontWeight: 700,
                          cursor: "pointer",
                          letterSpacing: 0.5,
                        }}
                      >
                        ⛶ AGRANDIR
                      </button>
                    </div>
                  </div>
                  <EquityChart
                    data={results.sampleEquity}
                    startBalance={startBalance}
                    targetDD={targetDD / 100}
                    medianEquity={results.medianEquity}
                    equityBands={results.equityBands}
                    ddBands={results.ddBands}
                    ruinedFrac={results.ruinedFracByTrade}
                  />
                </div>

                {/* Final balance distribution */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                  <Stat
                    label="Balance finale médiane"
                    value={`$${Math.round(results.finalMedian).toLocaleString()}`}
                    color={results.finalMedian >= startBalance ? ACCENT : DANGER}
                    big
                  />
                  <Stat label="P5 (mauvais scénario)" value={`$${Math.round(results.finalP5).toLocaleString()}`} color={DANGER} />
                  <Stat label="P95 (bon scénario)" value={`$${Math.round(results.finalP95).toLocaleString()}`} color={ACCENT} />
                  <Stat
                    label="Pire / meilleur final"
                    value={`$${Math.round(results.finalMin).toLocaleString()}`}
                    sub={`max $${Math.round(results.finalMax).toLocaleString()}`}
                    color="#e8edf5"
                  />
                </div>

                <div style={{ fontSize: 11, color: "#4f5870", lineHeight: 1.6 }}>
                  ⚠ Modèle simplifié : trades indépendants, win rate & RR fixes, pas de frais/slippage. La "ruine" =
                  premier moment où le drawdown depuis le pic atteint {targetDD}%. Mode {compounding ? "compounding" : "risque fixe"}.
                  {riskMode === "fwA" && ` Risque adaptatif : Standard ${riskPerTrade}% × coefficient de palier (PnL cumulé)${fwaUpOn ? "" : ", Draw Up OFF"}${fwaDownOn ? "" : ", Draw Down OFF"}. Standard remonté ${fwaRebaseValue > 0 ? `à chaque +${fwaRebaseValue}${fwaRebaseMode === "pct" ? "%" : "$"} de gain` : "jamais"}.`}
                  {" "}Résultats reproductibles via le seed. À utiliser pour comparer des stratégies, pas comme garantie.
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Fullscreen chart modal */}
      {expandedChart && results && (
        <div
          onClick={() => setExpandedChart(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(4,7,11,0.92)",
            backdropFilter: "blur(6px)",
            zIndex: 100,
            display: "flex",
            flexDirection: "column",
            padding: "24px 28px",
            cursor: "zoom-out",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div>
              <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 22, fontWeight: 800, color: "#fff" }}>
                Trajectoires Monte Carlo
              </span>
              <span style={{ fontSize: 12, color: "#67718a", marginLeft: 14 }}>
                {results.sampleEquity.length} trajectoires sur {results.numSims.toLocaleString()} simulées · {numTrades} trades
              </span>
            </div>
            <button
              onClick={() => setExpandedChart(false)}
              style={{
                background: "rgba(255,59,107,0.12)",
                border: `1px solid ${DANGER}`,
                color: DANGER,
                borderRadius: 8,
                padding: "8px 16px",
                fontSize: 13,
                fontFamily: "monospace",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              ✕ FERMER
            </button>
          </div>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              background: "#0a0e15",
              border: `1px solid ${GRID}`,
              borderRadius: 14,
              padding: 20,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              cursor: "default",
            }}
          >
            <EquityChart
              data={results.sampleEquity}
              startBalance={startBalance}
              targetDD={targetDD / 100}
              medianEquity={results.medianEquity}
              equityBands={results.equityBands}
              ddBands={results.ddBands}
              ruinedFrac={results.ruinedFracByTrade}
              expanded
            />
            <div style={{ marginTop: 10, fontSize: 11, color: "#5b6478", textAlign: "center" }}>
              Axe X = numéro du trade · Axe Y = balance ($) · clic en dehors pour fermer
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
