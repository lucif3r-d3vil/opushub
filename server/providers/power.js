// PowerProvider — the UPS and PDU abstraction, deliberately with nothing behind it yet.
//
// Phase 9 introduces the POWER domain because the OpusGrid model has to have somewhere for it to
// live before a protocol client exists. What is built here is the *shape*:
//
//   • two providers, `ups` and `pdu`, both answering `not-configured` until something real is
//     connected — which is the honest answer, because there is no way to detect UPS hardware
//     without a client (NUT, USB, SNMP) and guessing would be fabrication
//   • the fields each one will fill, declared as `planned` so the UI can list them in words
//     instead of showing an empty panel
//   • an explicit statement of what will NOT be built here: no shutdown, no battery test, no
//     outlet switching, no power cycling. Those are infrastructure *operations* and they belong
//     to a future phase with its own safety review.
//
// No capability is reported as available. Nothing in this file claims hardware exists.
import { getSettings } from '../model.js';

/**
 * The UPS read-only model, as it will be filled by a future client. Declared, never populated
 * from nothing: every field is null until a provider measures it.
 */
export const UPS_FIELDS = Object.freeze([
  'status', 'batteryChargePct', 'runtimeSec', 'loadPct', 'inputVoltage', 'outputVoltage',
  'temperatureC', 'lastUpdate',
]);

/** The PDU read-only model. Outlet control is explicitly out of scope. */
export const PDU_FIELDS = Object.freeze(['outletCount', 'outletStatus', 'powerWatts', 'lastUpdate']);

/** Operations a power provider must never grow into without a new phase. */
export const POWER_REFUSED = Object.freeze([
  'ups.shutdown', 'ups.test.battery', 'pdu.outlet.on', 'pdu.outlet.off', 'pdu.outlet.cycle',
]);

function settingsFor(id) {
  try {
    const s = getSettings();
    return s?.infrastructure?.power?.[id] || {};
  } catch {
    return {};
  }
}

/**
 * Build one power provider. `id` is 'ups' or 'pdu'.
 *
 * A future client slots in behind `check()`; until then the answer is `not-configured` with a
 * sentence that says what would have to be true for it to change.
 */
export function createPowerProvider({ id, label, planned, note }) {
  async function check() {
    const cfg = settingsFor(id);
    const configured = !!(cfg && (cfg.enabled === true || (typeof cfg.source === 'string' && cfg.source.trim())));
    if (!configured) {
      return {
        status: 'not-configured',
        capabilities: [],
        version: null,
        error: {
          code: 'not_configured',
          reason: `No ${label} provider is configured. OpusHub does not detect power hardware on its own — a ${label.toLowerCase()} client has to be connected first.`,
        },
        data: {
          device: null,
          fields: Object.fromEntries(planned.map((f) => [f, null])),
          planned: [...planned],
          refused: [...POWER_REFUSED],
          note,
          at: Date.now(),
        },
      };
    }
    // Configuration alone is not an implementation: nothing measures anything yet, so the honest
    // answer is still "not available", with the reason stated.
    return {
      status: 'unavailable',
      capabilities: [],
      version: null,
      error: {
        code: 'not_supported',
        reason: `${label} monitoring is not implemented yet. The configuration is stored, and the model is ready for a client.`,
      },
      data: {
        device: null,
        fields: Object.fromEntries(planned.map((f) => [f, null])),
        planned: [...planned],
        refused: [...POWER_REFUSED],
        note,
        at: Date.now(),
      },
    };
  }

  return { id, check, methods: {}, _internals: { planned, refused: POWER_REFUSED } };
}

export const upsProvider = createPowerProvider({
  id: 'ups',
  label: 'UPS',
  planned: UPS_FIELDS,
  note: 'Read-only when implemented: status, battery, runtime, load, voltages and temperature. No shutdown commands, no battery tests.',
});

export const pduProvider = createPowerProvider({
  id: 'pdu',
  label: 'PDU',
  planned: PDU_FIELDS,
  note: 'Read-only when implemented: outlet status and power draw. Switching outlets is out of scope for OpusHub.',
});
