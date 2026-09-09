import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseCandles } from '../../src/services/coinbase/coinbase.service.js';

export const CANDLE_CACHE = path.resolve('test-artifacts/forecast-evaluation/candles');
const MINUTE = 60_000;

export async function loadEvaluationCandles({ start, end, offline = false }) {
  if (
    ![start, end].every((value) => Number.isSafeInteger(value) && value % MINUTE === 0) ||
    start >= end ||
    end > Date.now()
  ) {
    throw new Error('A completed historical time range is required.');
  }
  await mkdir(CANDLE_CACHE, { recursive: true });
  const candlesByTime = new Map();
  const cachedMinutes = new Set();
  for (const filename of await readdir(CANDLE_CACHE)) {
    const match = /^(\d+)-(\d+)\.json$/.exec(filename);
    if (!match) continue;
    const pageStart = Number(match[1]);
    const pageEnd = Number(match[2]);
    if (pageEnd <= start || pageStart >= end) continue;
    const payload = JSON.parse(await readFile(path.join(CANDLE_CACHE, filename), 'utf8'));
    for (const candle of parseCandles(payload)) {
      if (candle.time < Math.max(start, pageStart) || candle.time >= Math.min(end, pageEnd))
        continue;
      const prior = candlesByTime.get(candle.time);
      if (prior && JSON.stringify(prior) !== JSON.stringify(candle)) {
        throw new Error(`Conflicting historical cache values at ${candle.time}.`);
      }
      candlesByTime.set(candle.time, candle);
    }
    // A validated response can omit no-trade intervals. Preserve those gaps rather than
    // treating them as uncached requests or filling them with fabricated prices.
    for (let time = Math.max(start, pageStart); time < Math.min(end, pageEnd); time += MINUTE)
      cachedMinutes.add(time);
  }
  let fetchedPages = 0;
  for (let cursor = start; cursor < end;) {
    if (cachedMinutes.has(cursor)) {
      cursor += MINUTE;
      continue;
    }
    let pageEnd = cursor + MINUTE;
    while (pageEnd < end && pageEnd - cursor < 299 * MINUTE && !cachedMinutes.has(pageEnd))
      pageEnd += MINUTE;
    if (offline) throw new Error(`Missing historical cache at ${new Date(cursor).toISOString()}.`);
    const parameters = new URLSearchParams({
      granularity: '60',
      start: new Date(cursor).toISOString(),
      end: new Date(pageEnd).toISOString(),
    });
    let payload;
    for (let attempt = 0; attempt < 4; attempt++) {
      await delay(attempt === 0 ? 1000 : 2000 * 2 ** attempt);
      try {
        const response = await fetch(
          `https://api.exchange.coinbase.com/products/BTC-USD/candles?${parameters}`,
          { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } },
        );
        if (!response.ok) throw new Error(`Coinbase HTTP ${response.status}`);
        payload = await response.json();
        parseCandles(payload);
        await writeFile(
          path.join(CANDLE_CACHE, `${cursor}-${pageEnd}.json`),
          `${JSON.stringify(payload)}\n`,
        );
        break;
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
    for (const candle of parseCandles(payload))
      if (candle.time >= cursor && candle.time < pageEnd) candlesByTime.set(candle.time, candle);
    cursor = pageEnd;
    fetchedPages++;
    if (fetchedPages % 10 === 0)
      console.log(
        `Fetched ${fetchedPages} missing pages; ${candlesByTime.size} cached candles in range.`,
      );
  }
  return [...candlesByTime.values()].sort((a, b) => a.time - b.time);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const candles = await loadEvaluationCandles({
    start: Date.parse(process.argv[2]),
    end: Date.parse(process.argv[3]),
    offline: process.argv.includes('--offline'),
  });
  console.log(
    JSON.stringify({ count: candles.length, first: candles[0]?.time, last: candles.at(-1)?.time }),
  );
}
