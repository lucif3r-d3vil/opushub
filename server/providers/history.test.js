// The host history sampler: one collector, three resolutions, a disk figure, honest averages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { History, sampleFrom } from './system.js';

const HOUR = 3600_000;
const point = (t, over = {}) => ({ t, cpu: 10, memUsedPct: 40, load: 1, rx: 100, tx: 50, temp: 40, procs: 200, diskUsedPct: 62, ...over });

test('sampleFrom records the root mount as diskUsedPct', () => {
  const doc = {
    at: 1000, cpu: { usage: 5, load1: 0.5, temperature: [{ celsius: 41 }] }, memory: { total: 100, available: 60 },
    network: [{ rxPerSec: 10, txPerSec: 5 }], processes: 99,
    disks: [{ mount: '/data', total: 1000, used: 900 }, { mount: '/', total: 200, used: 50 }],
  };
  const p = sampleFrom(doc);
  assert.equal(p.diskUsedPct, 25);
  assert.equal(p.memUsedPct, 40);
  assert.equal(sampleFrom({ ...doc, disks: [] }).diskUsedPct, null, 'no disk, no number');
});

test('windows read from the right resolution', () => {
  const h = new History({ intervalMs: 5000 });
  assert.equal(h.tierFor(HOUR), 'raw');
  assert.equal(h.tierFor(HOUR + 1), 'm5');
  assert.equal(h.tierFor(24 * HOUR), 'm5');
  assert.equal(h.tierFor(7 * 24 * HOUR), 'h1');
  assert.equal(h.stepMs(HOUR), 5000);
  assert.equal(h.stepMs(6 * HOUR), 300_000);
  assert.equal(h.stepMs(7 * 24 * HOUR), HOUR);
});

test('raw keeps an hour, tiers average and skip missing readings', () => {
  const h = new History({ intervalMs: 5000 });
  const base = Math.floor((Date.now() - 6 * HOUR) / HOUR) * HOUR;          // an hour boundary, six hours ago
  // two hours of samples every 30 s; temperature is missing for the first 30 minutes of hour one
  for (let t = base; t < base + 2 * HOUR; t += 30_000) h.add(point(t, { cpu: t < base + HOUR ? 10 : 30, temp: t < base + 30 * 60_000 ? null : 40 }));
  assert.ok(h.points.length <= h.samples, 'raw ring is bounded');
  const hourly = h.tiers.h1.done;
  assert.equal(hourly.length, 1, 'only closed hours are final');
  assert.equal(hourly[0].t, base + HOUR / 2, 'a bucket sits at its midpoint');
  assert.equal(hourly[0].cpu, 10);
  assert.equal(hourly[0].temp, 40, 'null readings are not averaged in as zeros');
  assert.equal(hourly[0].diskUsedPct, 62);
  const five = h.tiers.m5.done;
  assert.equal(five[0].temp, null, 'a bucket with no reading says null, not 0');
  const week = h.window(7 * 24 * HOUR);
  assert.equal(week.length, 2, 'the open hour is included as a partial point');
  assert.equal(week[1].cpu, 30);
});

test('the file round-trips, an old array file still loads, and old points are dropped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-hist-'));
  const file = path.join(dir, 'metrics.json');
  try {
    const now = Date.now();
    fs.writeFileSync(file, JSON.stringify([point(now - 10_000), point(now - 3 * HOUR)]));
    const legacy = new History({ file });
    await legacy.load();
    assert.equal(legacy.points.length, 1, 'v1 array loads; points older than an hour are not raw any more');

    const h = new History({ file });
    for (let t = now - 2 * HOUR; t < now; t += 60_000) h.add(point(t));
    h.save();
    const again = new History({ file });
    await again.load();
    assert.ok(again.points.length > 0 && again.tiers.m5.done.length > 0 && again.tiers.h1.done.length >= 1);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
