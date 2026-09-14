// MarketProvider tests — the upstream (Yahoo Finance chart API) is mocked at the fetch
// boundary, so these pin the parsing, the failure states and the "no fake data" contract
// without depending on the live provider.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPUSHUB_MARKET_TIMEOUT_MS = '400'; // keep the timeout test fast

const originalFetch = globalThis.fetch;

/** A minimal Response lookalike: status, headers, and a body stream that fetchText can read. */
function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** The shape the real chart endpoint returns (trimmed to what the provider reads). */
function chartDoc(meta, closes) {
  return {
    chart: {
      result: [{
        meta,
        timestamp: closes.map((_, i) => 1788874200 + i * 86400),
        indicators: { quote: [{ close: closes, high: closes, low: closes, open: closes, volume: closes.map(() => 1000) }] },
      }],
      error: null,
    },
  };
}
const AAPL_META = {
  currency: 'USD', symbol: 'AAPL', regularMarketPrice: 334.235, regularMarketChangePercent: 0.591,
  fulldayChange: 1.965, fulldayChangePercent: 0.591, regularMarketDayHigh: 335.5, regularMarketDayLow: 331.34,
  regularMarketVolume: 19837339, shortName: 'Apple Inc.', chartPreviousClose: 332.27, regularMarketTime: 1789405429,
};
const AAPL_CLOSES = [316.22, 315.34, 326.57, 332.27, 334.235];

test('market: a successful chart response parses into a full quote', async (t) => {
  const { __resetMarketCaches, getMarket } = await import('./market.js');
  const calls = [];
  globalThis.fetch = (async (url) => {
    calls.push(String(url));
    return jsonResponse(chartDoc(AAPL_META, AAPL_CLOSES));
  })
  try {
    __resetMarketCaches();
    const doc = await getMarket(['aapl']);
    assert.equal(doc.status, 'ok');
    assert.equal(doc.items.length, 1);
    const item = doc.items[0];
    assert.equal(item.symbol, 'AAPL');
    assert.equal(item.status, 'ok');
    assert.equal(item.price, 334.235);
    assert.equal(item.changePct, 0.591);
    assert.equal(item.change, 1.965);
    assert.equal(item.dayHigh, 335.5);
    assert.equal(item.dayLow, 331.34);
    assert.equal(item.volume, 19837339);
    assert.equal(item.currency, 'USD');
    assert.deepEqual(item.spark, AAPL_CLOSES);
    assert.ok(item.quoteDate, 'the quote carries its timestamp');
    // one request, per symbol, to the chart endpoint — quotes and history in one fetch
    assert.equal(calls.length, 1);
    assert.match(calls[0], /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/AAPL/);
    assert.match(calls[0], /range=1mo&interval=1d/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('market: cached — a second poll does not re-fetch', async () => {
  const { __resetMarketCaches, getMarket } = await import('./market.js');
  let n = 0;
  globalThis.fetch = (async () => { n++; return jsonResponse(chartDoc(AAPL_META, AAPL_CLOSES)); })
  try {
    __resetMarketCaches();
    await getMarket(['AAPL']);
    await getMarket(['AAPL']);
    assert.equal(n, 1, 'the quote cache must absorb the repeat poll');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('market: upstream 404 (a retired endpoint) is a clean unavailable, no upstream details', async () => {
  const { __resetMarketCaches, getMarket } = await import('./market.js');
  globalThis.fetch = (async () => jsonResponse({ error: 'gone' }, { status: 404 }))
  try {
    __resetMarketCaches();
    const doc = await getMarket(['AAPL', '^GSPC']);
    assert.equal(doc.status, 'unavailable');
    assert.ok(doc.reason, 'a human reason is present');
    const blob = JSON.stringify(doc);
    assert.ok(!blob.includes('404'), 'no upstream status code leaks');
    assert.ok(!blob.toLowerCase().includes('http'), 'no upstream URL leaks');
    assert.ok(!blob.includes('yahoo') && !blob.includes('stooq'), 'no provider internals leak');
    assert.deepEqual(doc.items, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('market: upstream timeout is an unavailable, not a hang or a 500', async () => {
  const { __resetMarketCaches, getMarket } = await import('./market.js');
  globalThis.fetch = (async (url, init) => {
    // never answers unless aborted — exactly what a dead upstream does
    return new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
      void resolve;
    });
  })
  try {
    __resetMarketCaches();
    const started = Date.now();
    const doc = await getMarket(['AAPL']);
    assert.ok(Date.now() - started < 5000, 'the timeout bound holds');
    assert.equal(doc.status, 'unavailable');
    assert.ok(!JSON.stringify(doc).includes('http'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('market: an invalid symbol is an honest no-data row, never a fake price', async () => {
  const { __resetMarketCaches, getMarket } = await import('./market.js');
  globalThis.fetch = (async () => jsonResponse({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }))
  try {
    __resetMarketCaches();
    const doc = await getMarket(['NOTAREALTICKER123']);
    assert.equal(doc.status, 'error');
    assert.equal(doc.items.length, 1);
    assert.equal(doc.items[0].status, 'no-data');
    assert.equal(doc.items[0].price, undefined, 'no invented price');
    assert.equal(doc.items[0].spark, undefined, 'no invented history');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('market: one good symbol and one dead one — the good one still shows', async () => {
  const { __resetMarketCaches, getMarket } = await import('./market.js');
  globalThis.fetch = (async (url) => {
    const u = String(url);
    if (u.includes('/AAPL')) return jsonResponse(chartDoc(AAPL_META, AAPL_CLOSES));
    return jsonResponse({ chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } });
  })
  try {
    __resetMarketCaches();
    const doc = await getMarket(['AAPL', 'ZZZZZZ']);
    assert.equal(doc.status, 'ok');
    const good = doc.items.find((i) => i.symbol === 'AAPL');
    const bad = doc.items.find((i) => i.symbol === 'ZZZZZZ');
    assert.equal(good?.status, 'ok');
    assert.equal(good?.price, 334.235);
    assert.equal(bad?.status, 'no-data');
    assert.match(String(doc.reason), /1 symbol\(s\) returned no data/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('market: empty watchlist is unconfigured, not an error', async () => {
  const { getMarket } = await import('./market.js');
  assert.equal((await getMarket([])).status, 'unconfigured');
  assert.equal((await getMarket(undefined)).status, 'unconfigured');
  assert.equal((await getMarket(['  '])).status, 'unconfigured', 'whitespace-only is the same as empty');
});

test('market: no fake data when the provider answers nothing parseable', async () => {
  const { __resetMarketCaches, getMarket } = await import('./market.js');
  globalThis.fetch = (async () => jsonResponse({ chart: { result: [{}], error: null } }))
  try {
    __resetMarketCaches();
    const doc = await getMarket(['AAPL']);
    assert.notEqual(doc.status, 'ok');
    for (const item of doc.items) {
      assert.equal(item.status, 'no-data');
      assert.equal(item.price, undefined);
      assert.equal(item.spark, undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('market: symbols are normalized (case, Stooq .US suffix) and de-duplicated', async () => {
  const { __resetMarketCaches, getMarket, validateSymbol } = await import('./market.js');
  assert.equal(validateSymbol('aapl').symbol, 'AAPL');
  assert.equal(validateSymbol('btc-usd').symbol, 'BTC-USD');
  assert.equal(validateSymbol('eurusd=x').symbol, 'EURUSD=X');
  assert.equal(validateSymbol('  ^gspc  ').symbol, '^GSPC');
  assert.equal(validateSymbol('RELIANCE.NS').symbol, 'RELIANCE.NS');
  assert.equal(validateSymbol('AAPL.US').symbol, 'AAPL', 'Stooq-era .US suffix migrates to the bare ticker');
  assert.equal(validateSymbol('https://example.com/aapl').symbol, null, 'URLs are never symbols');
  assert.equal(validateSymbol('AAPL&script').symbol, null);
  assert.equal(validateSymbol('a b').symbol, null);
  assert.equal(validateSymbol('').symbol, null);
  globalThis.fetch = (async (url) => jsonResponse(chartDoc({ ...AAPL_META, symbol: String(url).split('/').slice(-2)[0] }, AAPL_CLOSES)))
  try {
    __resetMarketCaches();
    const doc = await getMarket(['aapl', 'AAPL', 'aapl.us']);
    assert.equal(doc.items.length, 1, 'case + suffix variants collapse to one symbol');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('market: international and non-equity asset classes pass through unchanged', async () => {
  const { validateSymbol } = await import('./market.js');
  for (const s of ['RELIANCE.NS', 'TCS.NS', '^NSEI', '^GSPC', 'BTC-USD', 'EURUSD=X', 'GC=F', 'MSFT']) {
    assert.equal(validateSymbol(s).ok, true, `${s} must be accepted`);
  }
});
