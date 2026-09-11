// MarketProvider — Stooq (keyless CSV quotes + daily history). Symbols are user-configured in
// Settings → Integrations; nothing is hardcoded and no value is estimated. If Stooq is
// unreachable the widget reports `unavailable` with the real reason.
import { TimedCache } from '../lib/cache.js';
import { fetchText, parseCsvLine } from '../lib/net.js';

const quoteCache = new TimedCache({ max: 16 });
const histCache = new TimedCache({ max: 128 });
const QUOTE_TTL = 5 * 60 * 1000;
const HIST_TTL = 60 * 60 * 1000;

function normSymbol(raw) {
  let s = String(raw || '').trim().toUpperCase();
  if (!s) return null;
  if (s.startsWith('^') || /\./.test(s) || /^\d/.test(s)) return s.toLowerCase();
  // bare tickers default to US suffix; indices like NIFTY map to stooq ^nkx aliases via config text
  return `${s.toLowerCase()}.us`;
}

async function quotes(symbols) {
  const key = `q:${symbols.join(',')}`;
  const hit = quoteCache.get(key);
  if (hit) return hit;
  const csv = await fetchText(`https://stooq.com/q/l/?s=${symbols.join(',')}&f=sd2t2ohlcv&h&e=csv`, { timeoutMs: 9000 });
  const rows = csv.trim().split(/\r?\n/).slice(1).map(parseCsvLine);
  const out = {};
  for (const r of rows) {
    // SYMBOL DATE TIME OPEN HIGH LOW CLOSE VOLUME
    const close = parseFloat(r[6]);
    if (!Number.isFinite(close)) continue;
    out[r[0].toLowerCase()] = {
      symbol: r[0].toUpperCase(), date: r[1], time: r[2],
      open: parseFloat(r[3]), high: parseFloat(r[4]), low: parseFloat(r[5]), close,
      volume: /^\d+$/.test(r[7]) ? Number(r[7]) : null,
    };
  }
  quoteCache.set(key, out, QUOTE_TTL);
  return out;
}

async function history(symbol) {
  const key = `h:${symbol}`;
  const hit = histCache.get(key);
  if (hit) return hit;
  const csv = await fetchText(`https://stooq.com/q/d/l/?s=${symbol}&i=d`, { timeoutMs: 9000 });
  const lines = csv.trim().split(/\r?\n/);
  let closes = [];
  if (lines[0]?.toLowerCase().startsWith('date')) {
    closes = lines.slice(1).map((l) => parseFloat(parseCsvLine(l)[4])).filter(Number.isFinite).slice(-40);
  }
  histCache.set(key, closes, HIST_TTL);
  return closes;
}

export async function getMarket(symbolsRaw) {
  const symbols = (Array.isArray(symbolsRaw) ? symbolsRaw : [])
    .map(normSymbol).filter(Boolean);
  if (!symbols.length) {
    return { status: 'unconfigured', reason: 'No watchlist configured — add tickers in Settings → Integrations (e.g. AAPL, NVDA, RELIANCE.NS, ^NKX).', items: [] };
  }
  try {
    const q = await quotes(symbols);
    const items = [];
    for (const sym of symbols) {
      const quote = q[sym];
      if (!quote) { items.push({ symbol: sym.toUpperCase(), status: 'no-data', reason: 'no quote returned' }); continue; }
      const closes = await history(sym).catch(() => []);
      let changePct = null;
      if (closes.length >= 2) {
        const prev = closes[closes.length - 2];
        if (Number.isFinite(prev) && prev !== 0) changePct = 100 * ((quote.close - prev) / prev);
      }
      items.push({
        symbol: quote.symbol, status: 'ok',
        price: quote.close, currency: null,
        change: changePct != null ? quote.close - closes[closes.length - 2] : null,
        changePct,
        dayHigh: quote.high, dayLow: quote.low, volume: quote.volume,
        quoteDate: `${quote.date} ${quote.time}`.trim(),
        spark: closes.length > 1 ? closes : null,
      });
    }
    const okCount = items.filter((i) => i.status === 'ok').length;
    return {
      status: okCount ? 'ok' : 'error',
      reason: okCount ? (okCount < items.length ? `${items.length - okCount} symbol(s) returned no data` : null) : 'no symbols resolved',
      items, fetchedAt: Date.now(),
    };
  } catch (err) {
    return { status: 'unavailable', reason: `Market data unreachable: ${err.message}`, items: [] };
  }
}
