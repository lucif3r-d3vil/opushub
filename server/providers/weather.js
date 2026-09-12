// WeatherProvider — Open-Meteo: no API key, no account, free by design. Location is
// configurable (city string → geocoded, or explicit lat/lon). Never a hardcoded default:
// no location configured ⇒ the Hub shows "Set a location".
import { TimedCache } from '../lib/cache.js';
import { fetchJson } from '../lib/net.js';

const cache = new TimedCache({ max: 16 });
const TTL = 15 * 60 * 1000;

// WMO weather codes → [label, lucide icon]
const CODES = {
  0: ['Clear', 'sun'], 1: ['Mostly clear', 'sun-dim'], 2: ['Partly cloudy', 'cloud-sun'], 3: ['Overcast', 'cloud'],
  45: ['Fog', 'cloud-fog'], 48: ['Freezing fog', 'cloud-fog'], 51: ['Light drizzle', 'cloud-drizzle'],
  53: ['Drizzle', 'cloud-drizzle'], 55: ['Heavy drizzle', 'cloud-drizzle'], 56: ['Freezing drizzle', 'cloud-drizzle'],
  57: ['Freezing drizzle', 'cloud-drizzle'], 61: ['Light rain', 'cloud-rain'], 63: ['Rain', 'cloud-rain'],
  65: ['Heavy rain', 'cloud-hail'], 66: ['Freezing rain', 'cloud-snow'], 67: ['Freezing rain', 'cloud-snow'],
  71: ['Light snow', 'cloud-snow'], 73: ['Snow', 'cloud-snow'], 75: ['Heavy snow', 'snowflake'], 77: ['Snow grains', 'snowflake'],
  80: ['Rain showers', 'cloud-rain'], 81: ['Rain showers', 'cloud-heavy-rain'], 82: ['Violent showers', 'cloud-lightning'],
  85: ['Snow showers', 'cloud-snow'], 86: ['Snow showers', 'snowflake'], 95: ['Thunderstorm', 'cloud-lightning'],
  96: ['Thunderstorm, hail', 'cloud-lightning'], 99: ['Thunderstorm, hail', 'cloud-lightning'],
};
export const codeInfo = (c) => CODES[c] ?? ['Unknown conditions', 'cloud'];

async function geocode(city) {
  const key = `geo:${city.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const j = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`, { timeoutMs: 8000 });
  const g = j?.results?.[0];
  if (!g) throw new Error(`could not find "${city}"`);
  const out = { lat: g.latitude, lon: g.longitude, name: [g.name, g.admin1, g.country].filter(Boolean).join(', ') };
  cache.set(key, out, 30 * 24 * 3600_000);
  return out;
}

export async function getWeather(cfg) {
  if (!cfg || (!cfg.location && !(cfg.latitude != null && cfg.longitude != null))) {
    return { status: 'unconfigured', reason: 'No location configured.' };
  }
  const key = `wx:${cfg.location || `${cfg.latitude},${cfg.longitude}`}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    let { latitude, longitude, place } = {};
    if (cfg.latitude != null && cfg.longitude != null) {
      latitude = cfg.latitude; longitude = cfg.longitude;
      place = cfg.place || `${Number(cfg.latitude).toFixed(2)}, ${Number(cfg.longitude).toFixed(2)}`;
    } else {
      const g = await geocode(cfg.location);
      latitude = g.lat; longitude = g.lon; place = g.name;
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max&timezone=auto&forecast_days=5';
    const j = await fetchJson(url, { timeoutMs: 9000 });
    const c = j.current || {};
    const d = j.daily || {};
    const [label, icon] = codeInfo(c.weather_code);
    const out = {
      status: 'ok',
      place,
      fetchedAt: Date.now(),
      current: {
        tempC: c.temperature_2m, feelsC: c.apparent_temperature, humidity: c.relative_humidity_2m,
        windKph: c.wind_speed_10m, windDeg: c.wind_direction_10m, precipMm: c.precipitation,
        code: c.weather_code, label, icon, isDay: c.is_day === 1,
      },
      today: {
        highC: d.temperature_2m_max?.[0] ?? null, lowC: d.temperature_2m_min?.[0] ?? null,
        sunrise: d.sunrise?.[0] ?? null, sunset: d.sunset?.[0] ?? null,
        precipChance: d.precipitation_probability_max?.[0] ?? null,
      },
      forecast: (d.time || []).slice(0, 5).map((t, i) => ({
        date: t,
        label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(t + 'T12:00').toLocaleDateString('en', { weekday: 'short' }),
        code: d.weather_code?.[i] ?? null, highC: d.temperature_2m_max?.[i] ?? null, lowC: d.temperature_2m_min?.[i] ?? null,
        precipChance: d.precipitation_probability_max?.[i] ?? null,
      })),
      units: cfg.units === 'f' ? 'f' : 'c',
    };
    cache.set(key, out, TTL);
    return out;
  } catch (err) {
    const out = { status: 'unavailable', reason: `Weather service unreachable: ${err.message}` };
    cache.set(key, out, 60_000);
    return out;
  }
}

export function cToF(c) { return c == null ? null : Math.round((c * 9) / 5 + 32); }
