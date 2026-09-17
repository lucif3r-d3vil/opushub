// Phase 9E — the power abstraction: UPS and PDU as model slots with nothing behind them yet.
//
// The point of this file is the negative space. No client exists, so the only correct answers are
// "not configured" and "not available" — and the panel must be able to say which operations will
// never appear (shutdown, battery test, outlet switching).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9power-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9power-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const { createPowerProvider, upsProvider, pduProvider, UPS_FIELDS, PDU_FIELDS, POWER_REFUSED } = await import('./providers/power.js');
const { powerDocument } = await import('./infrastructure/opusgrid.js');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.yaml');
const readSettingsRaw = () => {
  try { return YAML.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch { return {}; }
};
const writeSettingsRaw = (value) => fs.writeFileSync(SETTINGS_FILE, YAML.stringify(value));

test.after(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('an unconfigured UPS answers not-configured, with no capability and no numbers', async () => {
  const result = await upsProvider.check();
  assert.equal(result.status, 'not-configured');
  assert.deepEqual(result.capabilities, [], 'no capability is claimed without a client');
  assert.equal(result.error.code, 'not_configured');
  assert.match(result.error.reason, /No UPS provider is configured/);
  assert.equal(result.data.device, null);
  assert.deepEqual(result.data.fields, Object.fromEntries(UPS_FIELDS.map((f) => [f, null])));
});

test('an unconfigured PDU says so, and names outlet control as out of scope', async () => {
  const result = await pduProvider.check();
  assert.equal(result.status, 'not-configured');
  assert.deepEqual(result.capabilities, []);
  assert.match(result.error.reason, /No PDU provider is configured/);
  assert.deepEqual([...result.data.planned], [...PDU_FIELDS]);
});

test('the model declares the fields a future client will fill, and refuses the operations it will not', async () => {
  assert.deepEqual([...UPS_FIELDS], ['status', 'batteryChargePct', 'runtimeSec', 'loadPct', 'inputVoltage', 'outputVoltage', 'temperatureC', 'lastUpdate']);
  assert.deepEqual([...PDU_FIELDS], ['outletCount', 'outletStatus', 'powerWatts', 'lastUpdate']);
  assert.deepEqual([...POWER_REFUSED], ['ups.shutdown', 'ups.test.battery', 'pdu.outlet.on', 'pdu.outlet.off', 'pdu.outlet.cycle']);
  for (const p of [upsProvider, pduProvider]) {
    const result = await p.check();
    assert.deepEqual([...result.data.refused], [...POWER_REFUSED]);
    assert.match(result.data.note, /[Rr]ead-only|out of scope/);
  }
});

test('configuration alone is not an implementation: a flagged device is still unavailable', async () => {
  const settings = readSettingsRaw() || {};
  writeSettingsRaw({ ...settings, infrastructure: { ...(settings.infrastructure || {}), power: { ups: { enabled: true } } } });
  const p = createPowerProvider({ id: 'ups', label: 'UPS', planned: [...UPS_FIELDS], note: 'test' });
  const result = await p.check();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error.code, 'not_supported');
  assert.match(result.error.reason, /not implemented yet/);
  assert.deepEqual(result.capabilities, [], 'a checkbox is not a client');
  writeSettingsRaw(settings);
});

test('the power domain document reports both devices and no hardware', async () => {
  const doc = await powerDocument();
  assert.deepEqual(doc.providers, ['ups', 'pdu']);
  assert.equal(doc.ups.status, 'not-configured');
  assert.equal(doc.pdu.status, 'not-configured');
  assert.match(doc.note, /read-only/i);
  for (const device of [doc.ups, doc.pdu]) {
    for (const value of Object.values(device.fields || {})) assert.equal(value, null, 'no field is filled from nothing');
  }
});
