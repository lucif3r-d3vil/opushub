// MarketProvider — Yahoo Finance's public chart endpoint (keyless, server-side JSON).
// Symbols are user-configured in Settings → Integrations; nothing is hardcoded and no value
// is estimated. If the provider is unreachable the widget reports `unavailable` with a clean
// reason — never an upstream status line or URL.
//
// Why Yahoo Finance:
//   · https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?range=1mo&interval=1d
//     is a stable public JSON endpoint — the same one Yahoo's own site and the widely used
//     yfinance client call. No API key, no crumb/cookie handshake (the older v7 /quote
//     endpoint was closed to keyless clients in 2025, which is why the chart API is used).
//   · One request returns BOTH the quote (meta) and ~30 daily closes (indicators.quote.close),
//     so the sparkline and the change both come from a single fetch per symbol.
//   · It covers the asset classes a homelab watchlist uses: US equities (AAPL), indices
//     (^GSPC, ^NSEI), crypto (BTC-USD), FX (EURUSD=X), futures (GC=F) and foreign exchanges
//     via suffix (RELIANCE.NS for NSE). Normalization happens here — the UI never has to
//     know provider-specific syntax.
//
// The old Stooq CSV endpoints (/q/l/, /q/d/l/) were retired: since March 2026 Stooq returns
// an HTML "request an API key" page (HTTP 404) instead of CSV for keyless clients, so it can
// no longer be a keyless provider.
import { TimedCache } from '../lib/cache.js';
import { fetchJson } from '../lib/net.js';

const HOST = 'query1.finance.yahoo.com';
const QUOTE_TTL = 5 * 60 * 1000;    // the Hub polls /api/market on the same cadence
const NO_DATA_TTL = 30 * 60 * 1000; // a symbol that does not exist does not start existing
const TIMEOUT_MS = Number(process.env.OPUSHUB_MARKET_TIMEOUT_MS || 10_000);
const MAX_SYMBOLS = 24;

// Yahoo symbol alphabet: letters, digits, ^ (index prefix), . (exchange suffix),
// = (FX/futures infix), - (crypto pair). A URL or free text can never match.
const SYMBOL_RE = /^[A-Z0-9^](?:[A-Z0-9.^\-=]{0,23})$/;

/**
 * Validate + normalize one user-supplied symbol. This is the only place the provider's
 * syntax lives — the UI sends whatever the user typed and keeps the normalized form.
 */
export function validateSymbol(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return { ok: false, symbol: null, reason: 'empty symbol' };
  // Stooq-era configs used a .US suffix for US tickers; Yahoo has none — migrate it.
  const symbol = s.endsWith('.US') ? s.slice(0, -3) : s;
  if (!symbol) return { ok: false, symbol: null, reason: 'empty symbol' };
  if (!SYMBOL_RE.test(symbol)) {
    return { ok: false, symbol: null, reason: 'a symbol is letters/digits with . ^ - = only (e.g. AAPL, ^GSPC, BTC-USD)' };
  }
  return { ok: true, symbol };
}

function quoteUrl(symbol) {
  return `https://${HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
}

function fmtTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * One symbol → one item (status ok), null for "the provider answered: no such symbol".
 * Network errors PROPAGATE — getMarket tells them apart from a definite no-data answer.
 */
async function quoteFor(symbol) {
  const hit = quoteCache.get(symbol);
  if (hit) return hit;
  if (noDataCache.get(symbol)) return null;
  if (inFlight.has(symbol)) return inFlight.get(symbol);
  const p = (async () => {
    try {
      const doc = await fetchJson(quoteUrl(symbol), { timeoutMs: TIMEOUT_MS });
      const result = doc?.chart?.result?.[0];
      const meta = result?.meta;
      const price = toNum(meta?.regularMarketPrice);
      if (!result || !meta || price == null) {
        noDataCache.set(symbol, true, NO_DATA_TTL);
        return null;
      }
      const closes = (result.indicators?.quote?.[0]?.close || []).map(toNum).filter((c) => c != null);
      const prev = toNum(meta.chartPreviousClose);
      let changePct = toNum(meta.fulldayChangePercent) ?? toNum(meta.regularMarketChangePercent);
      if (changePct == null && prev) changePct = 100 * ((price - prev) / prev);
      const item = {
        symbol: String(meta.symbol || symbol).toUpperCase(),
        status: 'ok',
        price,
        currency: typeof meta.currency === 'string' && meta.currency ? meta.currency : null,
        change: toNum(meta.fulldayChange) ?? (prev != null ? price - prev : null),
        changePct,
        dayHigh: toNum(meta.regularMarketDayHigh),
        dayLow: toNum(meta.regularMarketDayLow),
        volume: toNum(meta.regularMarketVolume),
        quoteDate: fmtTs(meta.regularMarketTime),
        name: typeof meta.shortName === 'string' && meta.shortName ? meta.shortName : null,
        spark: closes.length > 1 ? closes.slice(-30) : null,
      };
      quoteCache.set(symbol, item, QUOTE_TTL);
      return item;
    } finally {
      inFlight.delete(symbol);
    }
  })();
  inFlight.set(symbol, p);
  return p;
}

const quoteCache = new TimedCache({ max: 128 });
const noDataCache = new TimedCache({ max: 128 });
const inFlight = new Map();

/**
 * The watchlist, as the Hub consumes it. Every item is a real quote; a symbol the provider
 * does not know is an honest `no-data` row, and a provider that does not answer at all is a
 * structured `unavailable` — the widget never renders a number that was not fetched.
 */
export async function getMarket(symbolsRaw) {
  const symbols = [...new Set(
    (Array.isArray(symbolsRaw) ? symbolsRaw : [])
      .map((x) => validateSymbol(x).symbol)
      .filter(Boolean),
  )].slice(0, MAX_SYMBOLS);
  if (!symbols.length) {
    return { status: 'unconfigured', reason: 'No symbols in the watchlist — e.g. AAPL, RELIANCE.NS, ^GSPC, BTC-USD.', items: [] };
  }
  const settled = await Promise.all(symbols.map(async (s) => {
    try {
      return { s, item: await quoteFor(s), networkError: null };
    } catch (err) {
      return { s, item: null, networkError: String(err?.message || err) };
    }
  }));
  const items = settled.map(({ s, item, networkError }) => item || {
    symbol: s, status: 'no-data', reason: networkError ? 'the quote provider did not answer for this symbol' : 'no quote returned',
  });
  const okCount = items.filter((i) => i.status === 'ok').length;
  const netErrors = settled.filter((r) => r.networkError).length;
  if (okCount === 0 && netErrors === symbols.length) {
    // every single fetch failed at the network level: this is a provider outage, not a
    // bad watchlist — say exactly that, and nothing about the upstream
    return { status: 'unavailable', reason: 'The quote provider is not answering right now.', items: [] };
  }
  if (okCount === 0) {
    return { status: 'error', reason: 'No symbols resolved to quotes — check the symbol list.', items };
  }
  const bad = symbols.length - okCount;
  return {
    status: 'ok',
    reason: bad ? `${bad} symbol(s) returned no data` : null,
    items, fetchedAt: Date.now(),
  };
}

/** Test hook: clear the caches between runs. */
export function __resetMarketCaches() {
  quoteCache.map.clear();
  noDataCache.map.clear();
  inFlight.clear();
}
