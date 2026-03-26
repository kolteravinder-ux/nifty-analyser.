import { useState, useCallback } from "react";
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell
} from "recharts";

// ═══════════════════════════════════════════════════════
//  INDICATOR MATH
// ═══════════════════════════════════════════════════════

function calcEMA(arr, p) {
  if (!arr || arr.length < p) return (arr || []).map(() => null);
  const k = 2 / (p + 1);
  const out = new Array(p - 1).fill(null);
  let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out.push(+e.toFixed(2));
  for (let i = p; i < arr.length; i++) {
    e = arr[i] * k + e * (1 - k);
    out.push(+e.toFixed(2));
  }
  return out;
}

function calcRSI(arr, p = 14) {
  if (!arr || arr.length <= p) return (arr || []).map(() => null);
  const out = new Array(p).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) {
    const d = arr[i] - arr[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= p; al /= p;
  out.push(al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2));
  for (let i = p + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    ag = (ag * (p - 1) + g) / p;
    al = (al * (p - 1) + l) / p;
    out.push(al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2));
  }
  return out;
}

function calcMACD(arr) {
  const fast = 12, slow = 26, sig = 9;
  const e12 = calcEMA(arr, fast);
  const e26 = calcEMA(arr, slow);
  const line = arr.map((_, i) =>
    e12[i] != null && e26[i] != null ? +(e12[i] - e26[i]).toFixed(2) : null
  );
  const startIdx = line.findIndex(v => v != null);
  if (startIdx < 0) return { line, signal: line.map(() => null), hist: line.map(() => null) };
  const validLine = line.slice(startIdx);
  const sigArr = calcEMA(validLine, sig);
  const fullSig = new Array(startIdx).fill(null).concat(sigArr);
  const hist = line.map((v, i) =>
    v != null && fullSig[i] != null ? +(v - fullSig[i]).toFixed(2) : null
  );
  return { line, signal: fullSig, hist };
}

function calcATR(hs, ls, cs, p = 14) {
  if (hs.length < p) return 0;
  const trs = hs.map((h, i) => {
    if (i === 0) return h - ls[0];
    return Math.max(h - ls[i], Math.abs(h - cs[i - 1]), Math.abs(ls[i] - cs[i - 1]));
  });
  let a = trs.slice(0, p).reduce((x, y) => x + y, 0) / p;
  for (let i = p; i < trs.length; i++) a = (a * (p - 1) + trs[i]) / p;
  return +a.toFixed(2);
}

function calcPivots(h, l, c) {
  const pp = (h + l + c) / 3;
  return {
    pp: +pp.toFixed(2),
    r1: +(2 * pp - l).toFixed(2),
    r2: +(pp + h - l).toFixed(2),
    r3: +(h + 2 * (pp - l)).toFixed(2),
    s1: +(2 * pp - h).toFixed(2),
    s2: +(pp - h + l).toFixed(2),
    s3: +(l - 2 * (h - pp)).toFixed(2),
  };
}

function calcVolSMA(arr, p = 9) {
  return arr.map((_, i) => {
    if (i < p - 1) return null;
    return Math.round(arr.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p);
  });
}

// ═══════════════════════════════════════════════════════
//  DATA FETCHING — Yahoo Finance via CORS proxy
// ═══════════════════════════════════════════════════════

async function fetchMarketData(instrument, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // 09:10 IST = 03:40 UTC, 15:35 IST = 10:05 UTC (with buffer)
  const p1 = Math.floor(Date.UTC(y, m - 1, d, 3, 40, 0) / 1000);
  const p2 = Math.floor(Date.UTC(y, m - 1, d, 10, 10, 0) / 1000);
  const ticker = instrument === 'NIFTY50' ? '^NSEI' : '^NSEBANK';
  const base = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=5m&period1=${p1}&period2=${p2}&includePrePost=false`;
  const urls = [
    `https://corsproxy.io/?${base}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(base)}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      if (result?.timestamp?.length > 10) return result;
    } catch (_) {}
  }
  throw new Error(
    "Could not fetch data. Possible reasons: (1) Market holiday — try a weekday, (2) Date older than 60 days — Yahoo Finance only provides 5m data for ~60 days, (3) Network/CORS issue. Try a recent trading date."
  );
}

// ═══════════════════════════════════════════════════════
//  SHARED STYLES + HELPERS
// ═══════════════════════════════════════════════════════

const fmt = (n, dec = 2) =>
  typeof n === 'number'
    ? n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec })
    : '—';

const TOOLTIP_STYLE = {
  background: '#111827', border: '1px solid #1f2937', borderRadius: '8px',
  fontSize: '11px', color: '#e5e7eb', padding: '8px 12px', fontFamily: 'monospace',
};

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={TOOLTIP_STYLE}>
      <div style={{ color: '#6b7280', marginBottom: '4px' }}>{label}</div>
      {payload.map((p, i) =>
        p.value != null ? (
          <div key={i} style={{ color: p.color }}>
            {p.name}: {typeof p.value === 'number' ? p.value.toFixed(2) : p.value}
          </div>
        ) : null
      )}
    </div>
  );
}

function Badge({ verdict }) {
  const map = {
    Bullish: { bg: '#052e16', color: '#4ade80', border: '#14532d' },
    Bearish: { bg: '#450a0a', color: '#fca5a5', border: '#7f1d1d' },
    Neutral: { bg: '#1c1400', color: '#fcd34d', border: '#713f12' },
  };
  const s = map[verdict] || map.Neutral;
  return (
    <span style={{
      padding: '2px 10px', borderRadius: '100px', fontSize: '10px', fontWeight: 700,
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      fontFamily: 'monospace', letterSpacing: '0.04em',
    }}>
      {verdict.toUpperCase()}
    </span>
  );
}

function ChartCard({ title, subtitle, legend, children }) {
  return (
    <div style={{
      background: '#0d1117', border: '1px solid #1f2937', borderRadius: '10px',
      padding: '14px 16px', marginBottom: '10px',
    }}>
      <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '10px', fontWeight: 700, color: '#6b7280', letterSpacing: '0.1em', fontFamily: 'monospace' }}>
          {title}
        </span>
        <span style={{ fontSize: '11px', color: '#374151' }}>{subtitle}</span>
      </div>
      {children}
      {legend && (
        <div style={{ display: 'flex', gap: '16px', marginTop: '8px', flexWrap: 'wrap' }}>
          {legend.map(([label, color, dash]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', color: '#6b7280', fontFamily: 'monospace' }}>
              <div style={{ width: '16px', height: '2px', background: color, borderTop: dash ? '1px dashed ' + color : 'none' }} />
              <span style={{ color }}>{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NarrativeDisplay({ text }) {
  return (
    <div style={{ fontSize: '13px', lineHeight: 1.75, color: '#d1d5db' }}>
      {text.split('\n').map((line, i) => {
        if (line.startsWith('## ')) {
          return (
            <div key={i} style={{
              fontSize: '12px', fontWeight: 700, color: '#38bdf8', marginTop: '18px', marginBottom: '7px',
              borderLeft: '2px solid #0369a1', paddingLeft: '10px', letterSpacing: '0.02em',
            }}>
              {line.replace(/^## /, '')}
            </div>
          );
        }
        if (line.startsWith('- ') || line.startsWith('* ')) {
          return (
            <div key={i} style={{ paddingLeft: '14px', marginBottom: '3px', fontSize: '12px', color: '#9ca3af' }}>
              <span style={{ color: '#0ea5e9', marginRight: '6px' }}>›</span>
              {line.replace(/^[-*] /, '')}
            </div>
          );
        }
        if (line.startsWith('---')) return <div key={i} style={{ borderTop: '1px solid #1f2937', margin: '14px 0' }} />;
        if (!line.trim()) return <div key={i} style={{ height: '5px' }} />;
        if (line.startsWith('⚠️')) {
          return (
            <div key={i} style={{
              background: '#1c0a00', border: '1px solid #7c2d12', borderRadius: '6px',
              padding: '8px 12px', fontSize: '11px', color: '#fb923c', marginTop: '14px', fontFamily: 'monospace',
            }}>
              {line}
            </div>
          );
        }
        const parts = line.split(/\*\*(.*?)\*\*/g);
        return (
          <p key={i} style={{ margin: '2px 0' }}>
            {parts.map((p, j) =>
              j % 2 === 1
                ? <strong key={j} style={{ color: '#f3f4f6', fontWeight: 600 }}>{p}</strong>
                : p
            )}
          </p>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
//  RESULTS PANEL
// ═══════════════════════════════════════════════════════

function Results({ chartData, analysis: a, narrative, narrativePhase }) {
  const biasColor = a.bias === 'BULLISH' ? '#4ade80' : a.bias === 'BEARISH' ? '#f87171' : '#fcd34d';
  const chgPos = a.change >= 0;
  const xi = Math.max(1, Math.floor(chartData.length / 7));

  return (
    <div>
      {/* ── Summary Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: '8px', marginBottom: '10px' }}>
        {[
          {
            label: 'CLOSE PRICE',
            value: fmt(a.dayC, 2),
            sub: `${chgPos ? '+' : ''}${fmt(a.change, 2)} (${chgPos ? '+' : ''}${a.changePct}%)`,
            subColor: chgPos ? '#4ade80' : '#f87171',
          },
          {
            label: 'DAY RANGE',
            value: `${fmt(a.dayL, 0)} – ${fmt(a.dayH, 0)}`,
            sub: `ATR(14) = ${fmt(a.atr, 2)}`,
          },
          {
            label: 'RSI (14)',
            value: a.rsi?.toFixed(1) || '—',
            valueColor: a.rsi > 70 ? '#f87171' : a.rsi < 30 ? '#4ade80' : '#e5e7eb',
            sub: a.rsi > 70 ? 'Overbought ⚠' : a.rsi < 30 ? 'Oversold ⚠' : 'Neutral zone',
            subColor: a.rsi > 70 || a.rsi < 30 ? '#fcd34d' : '#6b7280',
          },
          {
            label: 'OVERALL BIAS',
            value: a.bias,
            valueColor: biasColor,
            sub: `${a.bull}↑ bullish  ${a.bear}↓ bearish  (of 5)`,
          },
        ].map((c, i) => (
          <div key={i} style={{
            background: '#0a0e17', border: '1px solid #1f2937', borderRadius: '10px',
            padding: '12px 14px', fontFamily: 'monospace',
          }}>
            <div style={{ fontSize: '9px', color: '#4b5563', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '6px' }}>{c.label}</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: c.valueColor || '#e5e7eb' }}>{c.value}</div>
            <div style={{ fontSize: '11px', color: c.subColor || '#4b5563', marginTop: '3px' }}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* ── OHLC Row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: '8px', marginBottom: '12px' }}>
        {[
          ['OPEN', a.dayO, '#94a3b8'],
          ['HIGH', a.dayH, '#4ade80'],
          ['LOW', a.dayL, '#f87171'],
          ['PREV CLOSE', a.prevC, '#6b7280'],
        ].map(([l, v, c]) => (
          <div key={l} style={{
            background: '#0a0e17', border: '1px solid #1f2937', borderRadius: '8px',
            padding: '7px 12px', fontFamily: 'monospace',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: '9px', color: '#4b5563', letterSpacing: '0.1em' }}>{l}</span>
            <span style={{ fontSize: '13px', fontWeight: 700, color: c }}>{fmt(v, 2)}</span>
          </div>
        ))}
      </div>

      {/* ── Indicator Signal Breakdown ── */}
      <div style={{
        background: '#0d1117', border: '1px solid #1f2937', borderRadius: '10px',
        padding: '14px 16px', marginBottom: '12px',
      }}>
        <div style={{ fontSize: '10px', fontWeight: 700, color: '#6b7280', letterSpacing: '0.1em', marginBottom: '10px', fontFamily: 'monospace' }}>
          SIGNAL BREAKDOWN — {a.bull}/5 BULLISH SIGNALS
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr auto', gap: '0', alignItems: 'center' }}>
          {a.signals.map((s, i) => (
            <>
              <div key={`n${i}`} style={{
                fontFamily: 'monospace', fontSize: '11px', fontWeight: 700, color: '#9ca3af',
                padding: '6px 0', borderBottom: i < a.signals.length - 1 ? '1px solid #111827' : 'none',
              }}>
                {s.name}
              </div>
              <div key={`r${i}`} style={{
                fontSize: '11px', color: '#4b5563', padding: '6px 12px',
                borderBottom: i < a.signals.length - 1 ? '1px solid #111827' : 'none',
              }}>
                {s.reason}
              </div>
              <div key={`b${i}`} style={{
                padding: '6px 0', textAlign: 'right',
                borderBottom: i < a.signals.length - 1 ? '1px solid #111827' : 'none',
              }}>
                <Badge verdict={s.verdict} />
              </div>
            </>
          ))}
        </div>
      </div>

      {/* ── Why These Indicators? ── */}
      <div style={{
        background: '#05080f', border: '1px dashed #1f2937', borderRadius: '10px',
        padding: '12px 16px', marginBottom: '12px', fontSize: '11px', color: '#4b5563', lineHeight: 1.7,
      }}>
        <span style={{ color: '#38bdf8', fontWeight: 700, fontFamily: 'monospace' }}>WHY THESE INDICATORS? </span>
        <span style={{ color: '#6b7280' }}>
          <strong style={{ color: '#9ca3af' }}>EMA(9,21)</strong> tracks short vs medium trend — crossovers signal momentum shifts.&nbsp;
          <strong style={{ color: '#9ca3af' }}>RSI(14)</strong> measures buying/selling pressure — extremes often precede reversals.&nbsp;
          <strong style={{ color: '#9ca3af' }}>MACD(12,26,9)</strong> shows trend strength and direction change — histogram expansion = acceleration.&nbsp;
          <strong style={{ color: '#9ca3af' }}>ATR(14)</strong> measures volatility for sizing stops and targets.&nbsp;
          <strong style={{ color: '#9ca3af' }}>Classic Pivots</strong> are S/R levels used by floor traders globally — price tends to react at these zones.
        </span>
      </div>

      {/* ── Price Chart ── */}
      <ChartCard
        title="PRICE + EMA (9, 21)"
        subtitle="5-minute close price with exponential moving averages"
        legend={[['Close', '#38bdf8', false], ['EMA 9', '#fb923c', true], ['EMA 21', '#c084fc', true]]}
      >
        <ResponsiveContainer width="100%" height={210}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#111827" />
            <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#4b5563', fontFamily: 'monospace' }} interval={xi} />
            <YAxis
              tick={{ fontSize: 9, fill: '#4b5563', fontFamily: 'monospace' }}
              domain={['auto', 'auto']}
              width={68}
              tickFormatter={v => v.toLocaleString('en-IN')}
            />
            <Tooltip content={<CustomTooltip />} />
            <Line type="monotone" dataKey="close" stroke="#38bdf8" dot={false} strokeWidth={1.8} name="Close" />
            <Line type="monotone" dataKey="ema9" stroke="#fb923c" dot={false} strokeWidth={1.2} name="EMA9" strokeDasharray="5 3" />
            <Line type="monotone" dataKey="ema21" stroke="#c084fc" dot={false} strokeWidth={1.2} name="EMA21" strokeDasharray="5 3" />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── RSI Chart ── */}
      <ChartCard
        title="RSI (14) — RELATIVE STRENGTH INDEX"
        subtitle="Momentum oscillator: >70 overbought (possible reversal), <30 oversold"
      >
        <ResponsiveContainer width="100%" height={140}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#111827" />
            <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#4b5563', fontFamily: 'monospace' }} interval={xi} />
            <YAxis tick={{ fontSize: 9, fill: '#4b5563', fontFamily: 'monospace' }} domain={[0, 100]} width={28} />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="4 3" strokeOpacity={0.7}
              label={{ value: '70', position: 'insideRight', fill: '#ef4444', fontSize: 9, fontFamily: 'monospace' }} />
            <ReferenceLine y={50} stroke="#374151" strokeDasharray="2 4" />
            <ReferenceLine y={30} stroke="#22c55e" strokeDasharray="4 3" strokeOpacity={0.7}
              label={{ value: '30', position: 'insideRight', fill: '#22c55e', fontSize: 9, fontFamily: 'monospace' }} />
            <Line type="monotone" dataKey="rsi" stroke="#a78bfa" dot={false} strokeWidth={1.6} name="RSI" />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── MACD Chart ── */}
      <ChartCard
        title="MACD (12, 26, 9)"
        subtitle="Trend momentum — green histogram = bullish pressure, red = bearish pressure"
        legend={[['MACD Line', '#38bdf8', false], ['Signal Line', '#fb7185', false], ['Histogram', '#6b7280', false]]}
      >
        <ResponsiveContainer width="100%" height={155}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#111827" />
            <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#4b5563', fontFamily: 'monospace' }} interval={xi} />
            <YAxis tick={{ fontSize: 9, fill: '#4b5563', fontFamily: 'monospace' }} width={48} />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="#374151" strokeWidth={1} />
            <Bar dataKey="hist" name="Histogram" maxBarSize={5}>
              {chartData.map((entry, index) => (
                <Cell key={index} fill={entry.hist >= 0 ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)'} />
              ))}
            </Bar>
            <Line type="monotone" dataKey="macd" stroke="#38bdf8" dot={false} strokeWidth={1.3} name="MACD" />
            <Line type="monotone" dataKey="signal" stroke="#fb7185" dot={false} strokeWidth={1.3} name="Signal" />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── Volume Chart ── */}
      <ChartCard
        title="VOLUME (×1000 SHARES)"
        subtitle="Green = bullish candle, red = bearish — amber line = 9-period SMA"
      >
        <ResponsiveContainer width="100%" height={130}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#111827" />
            <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#4b5563', fontFamily: 'monospace' }} interval={xi} />
            <YAxis tick={{ fontSize: 9, fill: '#4b5563', fontFamily: 'monospace' }} width={48} tickFormatter={v => `${v}K`} />
            <Tooltip content={<CustomTooltip />} formatter={v => [`${v}K`]} />
            <Bar dataKey="volume" name="Volume (K)" maxBarSize={8}>
              {chartData.map((entry, index) => (
                <Cell key={index} fill={entry.bullish ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)'} />
              ))}
            </Bar>
            <Line type="monotone" dataKey="volSma" stroke="#fbbf24" dot={false} strokeWidth={1.3} name="Vol SMA9 (K)" />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── Pivot Points ── */}
      <div style={{
        background: '#0d1117', border: '1px solid #1f2937', borderRadius: '10px',
        padding: '14px 16px', marginBottom: '12px',
      }}>
        <div style={{ fontSize: '10px', fontWeight: 700, color: '#6b7280', letterSpacing: '0.1em', marginBottom: '4px', fontFamily: 'monospace' }}>
          CLASSIC PIVOT POINTS
        </div>
        <div style={{ fontSize: '11px', color: '#374151', marginBottom: '10px' }}>
          Calculated from today's H/L/C — used as next-day support & resistance
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0,1fr))', gap: '6px' }}>
          {[
            { l: 'S3', v: a.piv.s3, c: '#dc2626', bg: '#1f0505' },
            { l: 'S2', v: a.piv.s2, c: '#ef4444', bg: '#1a0505' },
            { l: 'S1', v: a.piv.s1, c: '#f87171', bg: '#160505' },
            { l: 'PP', v: a.piv.pp, c: '#fcd34d', bg: '#1c1400' },
            { l: 'R1', v: a.piv.r1, c: '#86efac', bg: '#051505' },
            { l: 'R2', v: a.piv.r2, c: '#4ade80', bg: '#051a09' },
            { l: 'R3', v: a.piv.r3, c: '#22c55e', bg: '#051e0c' },
          ].map(({ l, v, c, bg }) => (
            <div key={l} style={{
              textAlign: 'center', padding: '8px 4px', background: bg,
              border: `1px solid ${c}30`, borderRadius: '6px', fontFamily: 'monospace',
            }}>
              <div style={{ fontSize: '9px', fontWeight: 700, color: c, letterSpacing: '0.08em', marginBottom: '4px' }}>{l}</div>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#e5e7eb' }}>{v.toLocaleString('en-IN')}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── AI Analysis ── */}
      <div style={{
        background: '#08101f', border: '1px solid #0c2a4a', borderRadius: '10px',
        padding: '16px 18px', marginBottom: '10px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <div style={{
            width: '7px', height: '7px', borderRadius: '50%',
            background: narrativePhase === 'loading' ? '#fbbf24' : narrativePhase === 'done' ? '#4ade80' : '#6b7280',
            boxShadow: narrativePhase === 'loading' ? '0 0 8px #fbbf2480' : narrativePhase === 'done' ? '0 0 6px #4ade8060' : 'none',
          }} />
          <span style={{ fontSize: '10px', fontWeight: 700, color: '#38bdf8', letterSpacing: '0.1em', fontFamily: 'monospace' }}>
            AI-GENERATED ANALYSIS + NEXT-DAY ACTION PLAN
          </span>
          <span style={{ fontSize: '9px', color: '#1f2937', marginLeft: 'auto', fontFamily: 'monospace' }}>claude-sonnet</span>
        </div>
        {narrativePhase === 'loading' && (
          <div style={{ color: '#4b5563', fontSize: '12px', fontFamily: 'monospace' }}>Analyzing session data and generating plan...</div>
        )}
        {narrativePhase === 'error' && (
          <div style={{ color: '#f87171', fontSize: '12px', fontFamily: 'monospace' }}>
            Could not generate AI narrative. Ensure you are using this app via the Claude.ai interface.
          </div>
        )}
        {narrativePhase === 'done' && narrative && <NarrativeDisplay text={narrative} />}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════

export default function App() {
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({ date: today, instrument: 'NIFTY50' });
  const [phase, setPhase] = useState('idle');
  const [errMsg, setErrMsg] = useState('');
  const [chartData, setChartData] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [narrative, setNarrative] = useState('');
  const [narrativePhase, setNarrativePhase] = useState('idle');

  const generateAINarrative = async (a) => {
    setNarrativePhase('loading');
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `You are a responsible FinTech educator and experienced quant analyst. Analyze this Indian market intraday session and provide a structured, educational next-day action plan. Use plain, clear language.

═════ SESSION DATA ═════
INSTRUMENT: ${a.instrument} | DATE: ${a.date}
OHLC: O=${a.dayO}  H=${a.dayH}  L=${a.dayL}  C=${a.dayC}
Previous Close: ${a.prevC} | Change: ${a.change} (${a.changePct}%)

INDICATORS (end-of-day readings):
• EMA9=${a.ema9?.toFixed(2)}, EMA21=${a.ema21?.toFixed(2)} → ${a.ema9 > a.ema21 ? 'EMA9 ABOVE EMA21 → bullish alignment' : 'EMA9 BELOW EMA21 → bearish alignment'}
• RSI(14)=${a.rsi?.toFixed(2)} → ${a.rsi > 70 ? 'OVERBOUGHT — potential reversal zone' : a.rsi < 30 ? 'OVERSOLD — potential bounce zone' : 'Neutral (between 30-70)'}
• MACD Line=${a.macd}, Signal=${a.macdSig} → ${parseFloat(a.macd) > parseFloat(a.macdSig) ? 'MACD ABOVE signal → building bullish momentum' : 'MACD BELOW signal → bearish momentum active'}
• ATR(14)=${a.atr} — use 1×ATR for stop loss, 2×ATR for target sizing
• Pivots: PP=${a.piv.pp} | R1=${a.piv.r1} R2=${a.piv.r2} R3=${a.piv.r3} | S1=${a.piv.s1} S2=${a.piv.s2} S3=${a.piv.s3}
• Signal Score: ${a.bull}/5 BULLISH, ${a.bear}/5 BEARISH → ${a.bias}

Respond with EXACTLY these section headers and nothing else before them:

## 📊 Indicator Breakdown
For each indicator (EMA, RSI, MACD, ATR, Pivots): one line saying what the reading is and what it means for tomorrow. Keep it plain — imagine explaining to a new trader.

## 🔍 Today's Session Pattern
2-3 sentences: What was the dominant pattern? Was it trending or ranging? Where was the key turning point?

## 🎯 Next-Day Outlook: ${a.bias}
2-3 sentences: Why this bias? What needs to happen to confirm it? What would invalidate it?

## 📋 Approximate Trade Setup
${a.bias === 'BULLISH' ? 'CE buy setup: Which strike to consider (near R1/ATM), entry trigger level, target (R1 or R2), stop loss (S1 or 1×ATR below entry). Explain the logic.' : a.bias === 'BEARISH' ? 'PE buy setup: Which strike to consider (near S1/ATM), entry trigger level, target (S1 or S2), stop loss (R1 or 1×ATR above entry). Explain the logic.' : 'Neutral — explain what to watch for. Should trader wait for opening 15-min candle? What confirmation is needed before entering?'}

## ⏰ Timing Guide
4 bullet points: When to observe, when to enter, when to book partial profit, when to exit. Include specific IST times where relevant (9:15-15:30 window).

## ⚠️ Risk Factors
3 specific bullet points: What external factors could invalidate this setup? (SGX Nifty, VIX level, global market, F&O data like PCR/OI)

## 📚 Educational Deep Dive
Pick the MOST RELEVANT indicator from today's data (the one that gave the strongest signal). Explain in detail: (1) what it measures, (2) how it's calculated in simple terms, (3) why traders trust it, (4) its key limitation. Make this genuinely educational.

---
⚠️ This analysis is for educational purposes only and does NOT constitute financial advice. Options trading carries substantial risk of loss. Past price patterns do not guarantee future results. Always verify with current F&O data, global cues, and consult a SEBI-registered investment advisor before placing any trades.`
          }]
        })
      });
      const j = await res.json();
      const text = j.content?.map(b => b.text || '').join('') || '';
      setNarrative(text);
      setNarrativePhase('done');
    } catch {
      setNarrativePhase('error');
    }
  };

  const run = useCallback(async () => {
    setPhase('loading');
    setErrMsg('');
    setChartData([]);
    setAnalysis(null);
    setNarrative('');
    setNarrativePhase('idle');

    try {
      const raw = await fetchMarketData(form.instrument, form.date);
      const { timestamp, indicators: { quote: [q] }, meta } = raw;

      const candles = timestamp
        .map((t, i) => ({ ts: t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }))
        .filter(c => c.o != null && c.c != null && c.h != null && c.l != null);

      if (candles.length < 20)
        throw new Error(`Only ${candles.length} candles found. Market was likely closed on this date (holiday or weekend).`);

      const cs = candles.map(c => c.c);
      const hs = candles.map(c => c.h);
      const ls = candles.map(c => c.l);
      const vs = candles.map(c => c.v);

      const ema9arr  = calcEMA(cs, 9);
      const ema21arr = calcEMA(cs, 21);
      const rsiArr   = calcRSI(cs);
      const { line: macdLine, signal: macdSig, hist: macdHist } = calcMACD(cs);
      const vSma     = calcVolSMA(vs);
      const atrVal   = calcATR(hs, ls, cs);

      const dayH = Math.max(...hs), dayL = Math.min(...ls);
      const dayO = candles[0].o, dayC = candles[candles.length - 1].c;
      const prevC = meta.chartPreviousClose ?? meta.previousClose ?? dayO;
      const piv = calcPivots(dayH, dayL, dayC);

      const l9   = ema9arr[ema9arr.length - 1];
      const l21  = ema21arr[ema21arr.length - 1];
      const lRSI = rsiArr[rsiArr.length - 1];
      const lMACD = macdLine[macdLine.length - 1];
      const lSig  = macdSig[macdSig.length - 1];

      let bull = 0, bear = 0;
      const signals = [];

      const sig = (name, bullCond, bullReason, bearReason, neutralReason = '') => {
        if (bullCond === null) {
          signals.push({ name, verdict: 'Neutral', reason: neutralReason });
        } else if (bullCond) {
          bull++; signals.push({ name, verdict: 'Bullish', reason: bullReason });
        } else {
          bear++; signals.push({ name, verdict: 'Bearish', reason: bearReason });
        }
      };

      sig('EMA Cross',
        l9 > l21,
        `EMA9 ${l9?.toFixed(1)} above EMA21 ${l21?.toFixed(1)}`,
        `EMA9 ${l9?.toFixed(1)} below EMA21 ${l21?.toFixed(1)}`
      );
      if (lRSI > 60)      sig('RSI Momentum', true,  `RSI ${lRSI?.toFixed(1)} — strong buying pressure`, '');
      else if (lRSI < 40) sig('RSI Momentum', false, '', `RSI ${lRSI?.toFixed(1)} — weak, selling dominates`);
      else                sig('RSI Momentum', null,  '', '', `RSI ${lRSI?.toFixed(1)} — mid-zone, no bias`);

      if (lMACD != null && lSig != null)
        sig('MACD Signal',
          lMACD > lSig,
          `MACD (${lMACD?.toFixed(1)}) above signal — building momentum`,
          `MACD (${lMACD?.toFixed(1)}) below signal — momentum fading`
        );

      sig('Day Candle',
        dayC > dayO,
        `Bullish close +${(dayC - dayO).toFixed(0)} pts (green candle)`,
        `Bearish close ${(dayC - dayO).toFixed(0)} pts (red candle)`
      );

      sig('Close vs Range',
        dayC > (dayH + dayL) / 2,
        'Closed in upper half of day's range',
        'Closed in lower half of day's range'
      );

      const bias = bull >= 4 ? 'BULLISH' : bear >= 4 ? 'BEARISH' : 'NEUTRAL';

      const cd = candles.map((c, i) => {
        const ist = new Date(c.ts * 1000).toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata', hour12: false,
        });
        return {
          time: ist,
          close: +c.c.toFixed(2),
          ema9:  ema9arr[i],
          ema21: ema21arr[i],
          rsi:   rsiArr[i],
          macd:  macdLine[i],
          signal: macdSig[i],
          hist:  macdHist[i],
          volume: Math.round(c.v / 1000),
          volSma: vSma[i] ? Math.round(vSma[i] / 1000) : null,
          bullish: c.c >= c.o,
        };
      });

      const a = {
        instrument: form.instrument, date: form.date,
        dayO: +dayO.toFixed(2), dayH: +dayH.toFixed(2), dayL: +dayL.toFixed(2), dayC: +dayC.toFixed(2),
        prevC: +prevC.toFixed(2),
        change: +(dayC - prevC).toFixed(2),
        changePct: +((dayC - prevC) / prevC * 100).toFixed(2),
        ema9: l9, ema21: l21, rsi: lRSI,
        macd: lMACD?.toFixed(2), macdSig: lSig?.toFixed(2),
        atr: atrVal, piv, bias, bull, bear, signals,
      };

      setChartData(cd);
      setAnalysis(a);
      setPhase('success');
      generateAINarrative(a);
    } catch (e) {
      setErrMsg(e.message || 'An error occurred. Please try again.');
      setPhase('error');
    }
  }, [form]);

  return (
    <div style={{ fontFamily: 'var(--font-sans)', background: '#060912', minHeight: '100vh', padding: '1rem 0', color: '#e2e8f0' }}>
      {/* Header */}
      <div style={{ marginBottom: '1.5rem', borderBottom: '1px solid #111827', paddingBottom: '1rem' }}>
        <div style={{ fontSize: '9px', color: '#0ea5e9', letterSpacing: '0.18em', fontFamily: 'monospace', marginBottom: '5px' }}>
          QUANT ANALYST  ·  FINTECH RESEARCH TOOL  ·  v1.0
        </div>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#f9fafb', margin: 0, letterSpacing: '-0.02em' }}>
          NIFTY / BANKNIFTY Intraday Analyzer
        </h1>
        <p style={{ fontSize: '12px', color: '#4b5563', marginTop: '4px', lineHeight: 1.6 }}>
          Fetches 5-min intraday data · Computes EMA, RSI, MACD, ATR, Pivots · Generates AI-powered next-day plan
        </p>
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '9px', color: '#4b5563', fontFamily: 'monospace', letterSpacing: '0.1em', marginBottom: '5px' }}>SESSION DATE</div>
          <input
            type="date" value={form.date} max={today}
            onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
            style={{
              padding: '8px 12px', fontSize: '13px', fontFamily: 'monospace',
              background: '#0d1117', border: '1px solid #1f2937', borderRadius: '8px',
              color: '#e5e7eb', width: '165px', outline: 'none',
            }}
          />
        </div>
        <div>
          <div style={{ fontSize: '9px', color: '#4b5563', fontFamily: 'monospace', letterSpacing: '0.1em', marginBottom: '5px' }}>INSTRUMENT</div>
          <select
            value={form.instrument}
            onChange={e => setForm(f => ({ ...f, instrument: e.target.value }))}
            style={{
              padding: '8px 12px', fontSize: '13px', fontFamily: 'monospace',
              background: '#0d1117', border: '1px solid #1f2937', borderRadius: '8px',
              color: '#e5e7eb', width: '170px', outline: 'none',
            }}
          >
            <option value="NIFTY50">NIFTY 50  (^NSEI)</option>
            <option value="BANKNIFTY">BANKNIFTY  (^NSEBANK)</option>
          </select>
        </div>
        <button
          onClick={run}
          disabled={phase === 'loading'}
          style={{
            padding: '9px 22px', fontSize: '12px', fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.08em',
            background: phase === 'loading' ? '#0d1117' : '#0ea5e9',
            color: phase === 'loading' ? '#4b5563' : '#000',
            border: phase === 'loading' ? '1px solid #1f2937' : 'none',
            borderRadius: '8px', cursor: phase === 'loading' ? 'not-allowed' : 'pointer',
          }}
        >
          {phase === 'loading' ? '⟳  ANALYZING...' : 'RUN ANALYSIS  →'}
        </button>
      </div>

      {/* Info note */}
      <div style={{
        background: '#05100f', border: '1px solid #064e3b', borderRadius: '8px',
        padding: '8px 12px', fontSize: '10px', color: '#34d399', fontFamily: 'monospace',
        marginBottom: '1.25rem', lineHeight: 1.6,
      }}>
        ℹ  Data source: Yahoo Finance (5-min, IST 09:15–15:30).&nbsp;
        Limit: ~60 days history.&nbsp;
        Use a recent weekday.&nbsp;
        Weekends/holidays will show an error.
      </div>

      {/* Error */}
      {phase === 'error' && (
        <div style={{
          background: '#1f0505', border: '1px solid #7f1d1d', borderRadius: '8px',
          padding: '10px 14px', color: '#fca5a5', fontSize: '12px',
          fontFamily: 'monospace', marginBottom: '1rem', lineHeight: 1.7,
        }}>
          ✗  {errMsg}
        </div>
      )}

      {/* Loading */}
      {phase === 'loading' && (
        <div style={{ textAlign: 'center', padding: '4rem 0', color: '#374151', fontSize: '12px', fontFamily: 'monospace' }}>
          Fetching market data  ·  Computing indicators  ·  Building charts...
        </div>
      )}

      {/* Results */}
      {phase === 'success' && analysis && (
        <Results
          chartData={chartData}
          analysis={analysis}
          narrative={narrative}
          narrativePhase={narrativePhase}
        />
      )}

      {/* Footer */}
      {phase === 'success' && (
        <div style={{
          borderTop: '1px solid #0d1117', paddingTop: '12px', marginTop: '8px',
          fontSize: '10px', color: '#1f2937', fontFamily: 'monospace', lineHeight: 1.7,
        }}>
          ⚠ NOT FINANCIAL ADVICE · Educational use only · Options carry substantial risk of loss ·
          Past patterns ≠ future results · Consult a SEBI-registered investment advisor
        </div>
      )}
    </div>
  );
}
