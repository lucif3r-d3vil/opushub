/* OpusHub design mockups — shared data and behaviour. Plain script, no build step.
   Everything here is fake and deterministic: a seeded generator makes the same "homelab" on
   every load, so Home and Uptime always agree with each other. */
(function () {
  'use strict';

  /* ───────────── seeded randomness ───────────── */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  /* ───────────── icons (24×24, 1.8 stroke; the product resolves real ones through Iconify) ───────────── */
  const I = {
    play: '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M10 9.2v5.6l4.8-2.8z"/>',
    music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="4"/><circle cx="9" cy="10" r="1.7"/><path d="M4 18l5-5 4 4 3-3 4 4"/>',
    tv: '<rect x="3" y="5" width="18" height="12" rx="3"/><path d="M8 21h8M12 17v4"/>',
    reel: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="6.4" r="1.2"/><circle cx="16.9" cy="14.8" r="1.2"/><circle cx="7.1" cy="14.8" r="1.2"/>',
    download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/>',
    home: '<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    shield: '<path d="M12 3l7 3v5c0 5-3.2 8.5-7 10-3.8-1.5-7-5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
    git: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-12 6"/>',
    file: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    bars: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    db: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    bell: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15zM10 21h4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    up: '<path d="M12 19V6M6.5 11.5L12 6l5.5 5.5"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>',
    plane: '<path d="M21 4L3 11l6 2 2 6 3-4 5 4z"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    start: '<path d="M8 5l11 7-11 7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
    restart: '<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M12 16h5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    chev: '<path d="M8 10l4 4 4-4"/>',
    chevr: '<path d="M10 8l4 4-4 4"/>',
    more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.1"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1-4 4-6 8-6s7 2 8 6"/>',
    logout: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    box: '<path d="M12 3l9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    heal: '<path d="M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10z"/><path d="M9.5 12h5M12 9.5v5"/>',
    file2: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-1.4-1-1.6-1-2.7 0-.9.7-1.5 1.7-1.5H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="10" r="1"/>',
  };
  function icon(name, size, cls) {
    return '<svg class="' + (cls || '') + '" width="' + (size || 20) + '" height="' + (size || 20) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (I[name] || '') + '</svg>';
  }

  /* ───────────── the fake homelab ───────────── */
  const STACKS = ['Media', 'Downloads', 'Home', 'Develop'];
  // stack hue: derived from the name, muted (the product does the same with a hash)
  function stackHue(name) { return [28, 212, 148, 268][STACKS.indexOf(name)] ?? hash(name) % 360; }

  // events: [minutes ago it started, duration in minutes, 'down' | 'degraded'] — one ongoing is start === dur
  const SERVICES = [
    { id: 'jellyfin', name: 'Jellyfin', icon: 'play', stack: 'Media', port: 8096, base: 38, update: ['10.9.7', '10.9.8'], events: [[560, 18, 'degraded']] },
    { id: 'navidrome', name: 'Navidrome', icon: 'music', stack: 'Media', port: 4533, base: 22, events: [] },
    { id: 'immich', name: 'Immich', icon: 'image', stack: 'Media', port: 2283, base: 96, events: [[14, 14, 'degraded']], note: 'unhealthy for 14 min' },
    { id: 'sonarr', name: 'Sonarr', icon: 'tv', stack: 'Downloads', port: 8989, base: 31, events: [[220, 11, 'degraded']] },
    { id: 'radarr', name: 'Radarr', icon: 'reel', stack: 'Downloads', port: 7878, base: 29, update: ['5.9.1', '5.10.0'], events: [] },
    { id: 'qbittorrent', name: 'qBittorrent', icon: 'download', stack: 'Downloads', port: 8080, base: 18, events: [[38, 38, 'down']], note: 'stopped 38 min ago · auto-heal paused after 3 tries' },
    { id: 'homeassistant', name: 'Home Assistant', icon: 'home', stack: 'Home', port: 8123, base: 44, events: [] },
    { id: 'pihole', name: 'Pi-hole', icon: 'shield', stack: 'Home', port: 8053, base: 12, events: [] },
    { id: 'vaultwarden', name: 'Vaultwarden', icon: 'key', stack: 'Home', port: 8200, base: 17, events: [[1560, 6, 'down']] },
    { id: 'gitea', name: 'Gitea', icon: 'git', stack: 'Develop', port: 3000, base: 41, events: [[7400, 45, 'degraded']] },
    { id: 'paperless', name: 'Paperless', icon: 'file', stack: 'Develop', port: 8000, base: 120, events: [[3000, 22, 'down'], [6400, 35, 'degraded']] },
    { id: 'grafana', name: 'Grafana', icon: 'bars', stack: 'Develop', port: 3001, base: 55, update: ['11.1.0', '11.2.0'], events: [] },
  ];

  function stateAt(svc, minsAgoFrom, minsAgoTo) {
    // worst state of any event overlapping the bucket [minsAgoFrom (newer edge) .. minsAgoTo (older edge)]
    let worst = 'ok';
    for (const [start, dur, kind] of svc.events) {
      const end = start - dur;
      if (start >= minsAgoFrom && end <= minsAgoTo) {
        if (kind === 'down') return 'down';
        worst = 'degraded';
      }
    }
    return worst;
  }

  const RANGES = { '24h': { n: 288, step: 5, label: 'Last 24 hours' }, '7d': { n: 336, step: 30, label: 'Last 7 days' } };

  function buildSeries(svc, range) {
    const R = RANGES[range], rand = rng(hash(svc.id + range));
    const now = Date.now(), out = [];
    for (let i = 0; i < R.n; i++) {
      const m = (R.n - 1 - i) * R.step;               // minutes ago for the newer edge of this bucket
      const state = stateAt(svc, m, m + R.step);
      const day = Math.sin(((now / 60000 - m) / 1440) * Math.PI * 2 - 1.2);
      let lat = svc.base * (0.82 + rand() * 0.36) * (1 + 0.14 * day);
      if (rand() < 0.025) lat *= 1.8 + rand() * 1.6;     // the odd slow request
      if (state === 'degraded') lat = svc.base * (4 + rand() * 3.4);
      if (state === 'down') lat = null;
      out.push({ t: now - m * 60000, state, lat: lat == null ? null : Math.round(lat) });
    }
    return out;
  }

  function downMinutes(svc, rangeMins) {
    let s = 0;
    for (const [start, dur, kind] of svc.events) {
      if (kind !== 'down') continue;
      const a = Math.min(start, rangeMins), b = Math.min(Math.max(start - dur, 0), rangeMins);
      s += Math.max(0, a - b);
    }
    return s;
  }

  function stats(svc, range) {
    const mins = RANGES[range].n * RANGES[range].step;
    const series = svc._series && svc._series[range] ? svc._series[range] : buildSeries(svc, range);
    const lats = series.map((p) => p.lat).filter((v) => v != null).sort((a, b) => a - b);
    const last = series[series.length - 1];
    return {
      uptime: 100 * (1 - downMinutes(svc, mins) / mins),
      p95: lats.length ? lats[Math.floor(lats.length * 0.95)] : null,
      avg: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null,
      now: last,
      series,
    };
  }

  function currentState(svc) { return stateAt(svc, 0, 5) === 'ok' ? 'ok' : stateAt(svc, 0, 5); }

  function incidents(range) {
    const mins = RANGES[range].n * RANGES[range].step, list = [];
    for (const s of SERVICES) for (const [start, dur, kind] of s.events) {
      if (start - dur > mins) continue;
      list.push({ svc: s, kind, startAgo: start, dur, ongoing: start - dur <= 1, at: Date.now() - start * 60000 });
    }
    return list.sort((a, b) => a.startAgo - b.startAgo);
  }

  /* ───────────── formatting ───────────── */
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const p2 = (n) => String(n).padStart(2, '0');
  function clock(d) { return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function dayClock(d) { return DAYS[d.getDay()] + ' ' + clock(d); }
  function dur(mins) {
    if (mins < 1) return '<1 min';
    if (mins < 60) return Math.round(mins) + ' min';
    if (mins < 1440) { const h = Math.floor(mins / 60), m = Math.round(mins % 60); return h + ' h' + (m ? ' ' + m + ' min' : ''); }
    const d = Math.floor(mins / 1440), h = Math.round((mins % 1440) / 60); return d + ' d' + (h ? ' ' + h + ' h' : '');
  }
  function ago(mins) { return mins < 1 ? 'just now' : dur(mins) + ' ago'; }

  /* ───────────── live-looking sparkline ─────────────
     N+1 points are drawn; every tick the whole path slides left by one step (CSS transform,
     linear), then the data shifts and the path is redrawn at translate(0) in the same frame. */
  const STATIC = /[?&]static\b/.test(location.search);            // ?static: settled frame for screenshots
  if (STATIC) document.documentElement.classList.add('static');
  const reduce = STATIC || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function spark(svg, o) {
    const NS = 'http://www.w3.org/2000/svg', n = o.n || 40, W = o.w || 120, H = o.h || 28, tick = o.tick || 1600;
    const step = W / (n - 1), pad = 3;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('preserveAspectRatio', 'none');
    const defs = document.createElementNS(NS, 'defs'), gid = 'g' + Math.random().toString(36).slice(2, 8);
    defs.innerHTML = '<linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".32"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient>';
    const g = document.createElementNS(NS, 'g'), area = document.createElementNS(NS, 'path'), line = document.createElementNS(NS, 'path');
    area.setAttribute('fill', 'url(#' + gid + ')'); line.setAttribute('fill', 'none'); line.setAttribute('stroke', o.color || 'var(--accent)');
    line.setAttribute('stroke-width', '1.6'); line.setAttribute('stroke-linejoin', 'round'); line.setAttribute('stroke-linecap', 'round'); line.setAttribute('vector-effect', 'non-scaling-stroke');
    g.append(area, line); svg.append(defs, g); svg.style.overflow = 'hidden';
    let v = o.start != null ? o.start : (o.min + o.max) / 2; const r = rng(hash(o.seed || 'x'));
    const gen = () => { v += (o.mean - v) * 0.14 + (r() - 0.5) * o.amp; v = Math.max(o.min, Math.min(o.max, v)); return v; };
    const data = Array.from({ length: n + 1 }, gen);
    const y = (val) => H - pad - ((val - o.min) / (o.max - o.min || 1)) * (H - pad * 2);
    function smooth(pts) { // midpoint quadratic smoothing
      let d = 'M' + pts[0][0] + ' ' + pts[0][1];
      for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; d += 'Q' + pts[i][0] + ' ' + pts[i][1] + ' ' + mx + ' ' + my; }
      const l = pts[pts.length - 1]; return d + 'L' + l[0] + ' ' + l[1];
    }
    function draw() {
      const pts = data.map((val, i) => [+(i * step).toFixed(2), +y(val).toFixed(2)]);
      const d = smooth(pts); line.setAttribute('d', d); area.setAttribute('d', d + 'L' + pts[pts.length - 1][0] + ' ' + H + 'L0 ' + H + 'Z');
      if (o.onValue) o.onValue(data[n - 1]);
    }
    draw();
    if (reduce) return;
    function advance() {
      g.style.transition = 'transform ' + tick + 'ms linear'; g.style.transform = 'translateX(' + (-step) + 'px)';
      setTimeout(() => {
        data.shift(); data.push(gen());
        g.style.transition = 'none'; g.style.transform = 'translateX(0)'; draw();
        void g.getBoundingClientRect(); advance();
      }, tick);
    }
    // stagger so the sparklines do not all tick on the same frame
    setTimeout(advance, Math.floor(r() * tick));
  }


  /* ───────────── the pulse ribbon ─────────────
     One continuous shape per service. Colour = state (hard edges where the state changes),
     thickness = response time (swells when slow, a hairline when down). Geometry is built in a
     1000-wide viewBox and stretched to the row, so it is crisp at any width. */
  const STATE_COLOR = { ok: 'var(--ok)', degraded: 'var(--warn)', down: 'var(--fail)', nodata: 'var(--ink-3)' };
  let ribSeq = 0;
  function ribbon(series, o) {
    o = o || {};
    const W = 1000, H = o.h || 40, c = H / 2, n = series.length, base = o.base || 50;
    const minH = o.minH || 1.9, maxH = o.maxH || (H / 2 - 2);
    const half = series.map((p) => {
      if (p.state === 'down') return 1.3;
      if (p.lat == null) return 1;
      const t = Math.min(1, Math.max(0, (p.lat - base * 0.7) / (base * 5)));   // 0 at a healthy baseline, 1 at ~5x slower
      return minH + (maxH - minH) * Math.pow(t, 1.2);
    });
    const K = [1, 2, 3, 2, 1], KS = 9, at = (i) => half[Math.min(n - 1, Math.max(0, i))];   // 5-tap smoothing; down stays a hairline
    const sm = half.map((h, i) => (series[i].state === 'down' ? h : K.reduce((a, w, k) => a + w * at(i + k - 2), 0) / KS));
    for (let i = 0; i < 10 && i < n; i++) sm[i] *= 0.4 + 0.6 * (i / 10);   // the oldest edge tapers in; the newest edge stays full
    const x = (i) => ((i / (n - 1)) * W).toFixed(1);
    let top = '', bot = '';
    for (let i = 0; i < n; i++) top += (i ? 'L' : 'M') + x(i) + ' ' + (c - sm[i]).toFixed(2);
    for (let i = n - 1; i >= 0; i--) bot += 'L' + x(i) + ' ' + (c + sm[i]).toFixed(2);
    // gradient stops: one pair per run of equal state, shared offsets give hard edges
    let stops = '', runStart = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || series[i].state !== series[runStart].state) {
        const a = Math.max(0, (runStart - 0.5) / (n - 1)), b = Math.min(1, (i - 1 + 0.5) / (n - 1)), col = STATE_COLOR[series[runStart].state];
        stops += '<stop offset="' + a.toFixed(4) + '" style="stop-color:' + col + '"/><stop offset="' + b.toFixed(4) + '" style="stop-color:' + col + '"/>';
        runStart = i;
      }
    }
    const id = 'rb' + (++ribSeq);
    return '<svg class="rib' + (o.cls ? ' ' + o.cls : '') + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' + (o.label ? 'role="img" aria-label="' + o.label + '"' : 'aria-hidden="true"') + '>' +
      '<defs><linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="' + W + '" y2="0">' + stops + '</linearGradient></defs>' +
      '<line x1="0" x2="' + W + '" y1="' + c + '" y2="' + c + '" stroke="var(--hair)" stroke-width="1" vector-effect="non-scaling-stroke"/>' +
      '<path d="' + top + bot + 'Z" fill="url(#' + id + ')" fill-opacity=".92"/></svg>';
  }

  /* ───────────── chrome: background, top bar, bell panel, background switcher ───────────── */

  /* ───────────── shared state from the URL (review switches) ───────────── */
  const Q = new URLSearchParams(location.search);
  const USER = (Q.get('user') || 'admin').slice(0, 24);     // placeholder: the administrator's account name

  /* ───────────── per-container detail (for Containers, drawer, logs) ───────────── */
  const DETAIL_EXTRA = {
    jellyfin: { image: 'jellyfin/jellyfin', tag: '10.9.7', cpu: 3.1, mem: 612, up: '6 days', nets: ['media'], vols: ['/srv/media:/media:ro', 'jellyfin-config:/config'] },
    navidrome: { image: 'deluan/navidrome', tag: '0.53.3', cpu: 0.4, mem: 118, up: '18 days', nets: ['media'], vols: ['/srv/music:/music:ro', 'navidrome-data:/data'] },
    immich: { image: 'ghcr.io/immich-app/immich-server', tag: 'v1.115.0', cpu: 41.8, mem: 2310, up: '3 days', nets: ['media', 'internal'], vols: ['/srv/photos:/usr/src/app/upload', 'immich-ml-cache:/cache'] },
    sonarr: { image: 'lscr.io/linuxserver/sonarr', tag: '4.0.9', cpu: 0.9, mem: 244, up: '11 days', nets: ['downloads'], vols: ['/srv/tv:/tv', '/srv/downloads:/downloads'] },
    radarr: { image: 'lscr.io/linuxserver/radarr', tag: '5.9.1', cpu: 0.7, mem: 221, up: '11 days', nets: ['downloads'], vols: ['/srv/movies:/movies', '/srv/downloads:/downloads'] },
    qbittorrent: { image: 'lscr.io/linuxserver/qbittorrent', tag: '4.6.7', cpu: 0, mem: 0, up: 'exited 38 min ago', nets: ['downloads'], vols: ['/srv/downloads:/downloads', 'qbt-config:/config'] },
    homeassistant: { image: 'ghcr.io/home-assistant/home-assistant', tag: '2024.9.3', cpu: 2.2, mem: 540, up: '18 days', nets: ['host'], vols: ['ha-config:/config'] },
    pihole: { image: 'pihole/pihole', tag: '2024.07.0', cpu: 0.3, mem: 96, up: '18 days', nets: ['host'], vols: ['pihole-etc:/etc/pihole'] },
    vaultwarden: { image: 'vaultwarden/server', tag: '1.32.0', cpu: 0.1, mem: 38, up: '26 hours', nets: ['internal'], vols: ['vw-data:/data'] },
    gitea: { image: 'gitea/gitea', tag: '1.22.2', cpu: 0.6, mem: 301, up: '9 days', nets: ['internal'], vols: ['gitea-data:/data'] },
    paperless: { image: 'ghcr.io/paperless-ngx/paperless-ngx', tag: '2.12.1', cpu: 1.4, mem: 880, up: '2 days', nets: ['internal'], vols: ['/srv/docs:/usr/src/paperless/media'] },
    grafana: { image: 'grafana/grafana', tag: '11.1.0', cpu: 1.1, mem: 190, up: '9 days', nets: ['internal'], vols: ['grafana-data:/var/lib/grafana'] },
  };
  function detail(svc) {
    const d = DETAIL_EXTRA[svc.id], st = currentState(svc);
    return Object.assign({
      state: svc.id === 'qbittorrent' ? 'exited' : 'running', health: st === 'degraded' ? 'unhealthy' : st === 'down' ? '—' : 'healthy',
      policy: 'unless-stopped', ports: [svc.port + ':' + svc.port], autoheal: ['immich', 'qbittorrent', 'paperless', 'jellyfin'].includes(svc.id), checks: svc.id !== 'pihole',
      url: 'http://nas.lan:' + svc.port, id: svc.id.slice(0, 2) + (hash(svc.id) % 0xffffff).toString(16).padStart(6, '0') + 'a1',
    }, d);
  }
  function logs(svc, n) {
    const r = rng(hash(svc.id + 'log')), base = Date.now(), out = [];
    const ok = { jellyfin: ['GET /Items 200 41ms', 'Playback started user=nora', 'Library scan finished: 0 changes'], navidrome: ['Scan finished: 4,212 tracks', 'GET /rest/ping 200'], immich: ['job queue: thumbnail-generation 12 pending', 'GET /api/server-info/ping 200'], qbittorrent: ['Peer connected', 'Torrent finished: ubuntu-24.04.iso'], default: ['GET /health 200', 'Request handled in 24ms', 'Cache refreshed'] };
    const pool = ok[svc.id] || ok.default, gap = svc.id === 'qbittorrent' ? 70000 : 22000;
    let t = base - n * gap * 1.4;
    for (let i = 0; i < n; i++) { t += gap * (0.8 + r() * 0.6); out.push([new Date(t), 'INFO', pool[Math.floor(r() * pool.length)]]); }
    if (svc.id === 'immich') { out.splice(-4, 4, [new Date(base - 5 * 60000), 'WARN', 'healthcheck: GET /api/server-info/ping timed out after 5000ms'], [new Date(base - 3 * 60000), 'WARN', 'healthcheck failed (3 in a row)'], [new Date(base - 90000), 'INFO', 'job queue: thumbnail-generation 412 pending'], [new Date(base - 30000), 'WARN', 'ML worker busy, request queued']); }
    if (svc.id === 'qbittorrent') { out.splice(-3, 3, [new Date(base - 39 * 60000), 'ERROR', 'listen socket error: address already in use'], [new Date(base - 38 * 60000), 'FATAL', 'process exited with code 137 (SIGKILL)'], [new Date(base - 36 * 60000), 'INFO', 'auto-heal: restart attempt 3 of 3 failed, pausing']); }
    return out.sort((a, b) => a[0] - b[0]);
  }

  /* ───────────── host metrics: expandable charts (1h / 24h / 7d) ───────────── */
  const METRICS = {
    cpu: { label: 'CPU', unit: '%', mean: 16, amp: 12, lo: 0, hi: null, daily: 0.45, fmt: (v) => Math.round(v) + '%', note: '16 threads · load 1.2' },
    memory: { label: 'Memory', unit: '%', mean: 41.5, amp: 1.6, lo: null, hi: null, daily: 0.2, fmt: (v) => v.toFixed(1) + '%', note: '13.3 GB of 32 GB used' },
    network: { label: 'Network, download', unit: 'MB/s', mean: 9, amp: 12, lo: 0, hi: null, daily: 0.6, fmt: (v) => v.toFixed(1) + ' MB/s', note: 'all interfaces, combined' },
    disk: { label: 'Disk /', unit: '%', mean: 62, amp: 0.08, lo: null, hi: null, daily: 0, drift: 0.9, fmt: (v) => v.toFixed(2) + '%', note: '1.12 TB of 1.8 TB used' },
    temp: { label: 'Temperature', unit: '°C', mean: 41, amp: 1.6, lo: null, hi: null, daily: 0.4, fmt: (v) => Math.round(v) + '°C', note: 'CPU package' },
  };
  const HR = { '1h': { n: 60, step: 1, label: 'Last hour' }, '24h': { n: 96, step: 15, label: 'Last 24 hours' }, '7d': { n: 168, step: 60, label: 'Last 7 days' } };
  function metricSeries(id, range) {
    const m = METRICS[id], R = HR[range], r = rng(hash(id + range)), now = Date.now(), pts = [];
    let v = m.mean;
    for (let i = 0; i < R.n; i++) {
      const minsAgo = (R.n - 1 - i) * R.step, day = Math.sin(((now / 60000 - minsAgo) / 1440) * Math.PI * 2 - 1.5);
      v += (m.mean - v) * 0.12 + (r() - 0.5) * m.amp * (range === '1h' ? 1 : 1.4);
      let val = v + day * m.daily * m.amp * 2;
      if (id === 'disk') val = m.mean - m.drift * (minsAgo / (7 * 1440)) + (r() - 0.5) * m.amp;
      if (id === 'network' && r() < 0.05) val += m.amp * (1.5 + r() * 2);
      if (m.lo != null) val = Math.max(m.lo, val);
      pts.push({ t: now - minsAgo * 60000, v: val });
    }
    return pts;
  }
  function smoothPath(pts) {
    let d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; d += 'Q' + pts[i][0].toFixed(1) + ' ' + pts[i][1].toFixed(1) + ' ' + mx.toFixed(1) + ' ' + my.toFixed(1); }
    const l = pts[pts.length - 1]; return d + 'L' + l[0].toFixed(1) + ' ' + l[1].toFixed(1);
  }
  function whenLabel(range, t, long) {
    const d = new Date(t);
    if (range === '7d') return long ? dayClock(d) : DAYS[d.getDay()];
    return clock(d);
  }
  function metricStats(id, range) {
    const pts = metricSeries(id, range), vs = pts.map((p) => p.v), peak = Math.max(...vs), low = Math.min(...vs);
    return { pts, now: vs[vs.length - 1], avg: vs.reduce((a, b) => a + b, 0) / vs.length, peak, peakAt: pts[vs.indexOf(peak)].t, low, lowAt: pts[vs.indexOf(low)].t };
  }
  function bigChart(host, id, range) {
    const m = METRICS[id], st = metricStats(id, range), pts = st.pts, n = pts.length;
    const W = 900, H = 270, pl = 52, pr = 14, pt = 16, pb = 30;
    let lo = m.lo != null ? m.lo : Math.min(st.low, st.avg) - (st.peak - st.low) * 0.25 - 0.05, hi = Math.max(st.peak, st.avg) + (st.peak - Math.min(st.low, 0)) * 0.18 + 0.05;
    if (id === 'cpu' || id === 'memory') hi = Math.min(100, hi);
    if (id === 'cpu') lo = 0;
    const x = (i) => pl + (i / (n - 1)) * (W - pl - pr), y = (v) => pt + (1 - (v - lo) / (hi - lo || 1)) * (H - pt - pb);
    const xy = pts.map((p, i) => [x(i), y(p.v)]), d = smoothPath(xy), gid = 'bc' + Math.random().toString(36).slice(2, 7);
    let grid = '', xl = '';
    for (let k = 0; k <= 4; k++) { const v = lo + ((hi - lo) * k) / 4, yy = y(v); grid += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--hair)" ' + (k ? 'stroke-dasharray="2 5"' : '') + '/><text x="' + (pl - 10) + '" y="' + (yy + 4) + '" text-anchor="end">' + (id === 'network' ? v.toFixed(0) : id === 'disk' ? v.toFixed(1) : Math.round(v)) + '</text>'; }
    for (let k = 0; k <= 4; k++) { const i = Math.round((k / 4) * (n - 1)); xl += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="' + (k === 0 ? 'start' : k === 4 ? 'end' : 'middle') + '">' + (k === 4 ? 'now' : whenLabel(range, pts[i].t)) + '</text>'; }
    const pi = pts.findIndex((p) => p.v === st.peak);
    host.innerHTML = '<svg class="bigc" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + m.label + ', ' + HR[range].label.toLowerCase() + ': now ' + m.fmt(st.now) + ', average ' + m.fmt(st.avg) + ', peak ' + m.fmt(st.peak) + '"><defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".34"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>' +
      '<g class="grid">' + grid + xl + '</g>' +
      '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(st.avg) + '" y2="' + y(st.avg) + '" stroke="var(--ink-3)" stroke-dasharray="6 6" opacity=".6"/><text class="avgl" x="' + (W - pr - 4) + '" y="' + (y(st.avg) - 6) + '" text-anchor="end">avg ' + m.fmt(st.avg) + '</text>' +
      '<path d="' + d + 'L' + x(n - 1) + ' ' + (H - pb) + 'L' + pl + ' ' + (H - pb) + 'Z" fill="url(#' + gid + ')"/><path class="ln" d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + x(pi) + '" cy="' + y(st.peak) + '" r="4" fill="var(--warn)"/><text class="pk" x="' + x(pi) + '" y="' + (y(st.peak) - 10) + '" text-anchor="' + (pi > n * 0.8 ? 'end' : pi < n * 0.1 ? 'start' : 'middle') + '">peak ' + m.fmt(st.peak) + '</text>' +
      '<line class="cxl" x1="0" x2="0" y1="' + pt + '" y2="' + (H - pb) + '" stroke="var(--ink)" opacity="0"/><circle class="cxd" r="4.5" fill="var(--bg)" stroke="var(--accent)" stroke-width="2" opacity="0"/></svg><div class="cxt" role="presentation"></div>';
    const svg = host.querySelector('svg'), tip = host.querySelector('.cxt'), cl = svg.querySelector('.cxl'), cd = svg.querySelector('.cxd');
    function at(clientX) {
      const r = svg.getBoundingClientRect(), f = Math.min(1, Math.max(0, ((clientX - r.left) / r.width * W - pl) / (W - pl - pr))), i = Math.round(f * (n - 1)), px = x(i), py = y(pts[i].v);
      cl.setAttribute('x1', px); cl.setAttribute('x2', px); cl.setAttribute('opacity', '.55'); cd.setAttribute('cx', px); cd.setAttribute('cy', py); cd.setAttribute('opacity', '1');
      tip.innerHTML = '<b>' + m.fmt(pts[i].v) + '</b><em>' + whenLabel(range, pts[i].t, true) + '</em>'; tip.classList.add('on');
      const left = (px / W) * r.width, w = tip.offsetWidth; tip.style.left = Math.max(4, Math.min(r.width - w - 4, left - w / 2)) + 'px'; tip.style.top = Math.max(0, (py / H) * r.height - 54) + 'px';
    }
    svg.addEventListener('pointermove', (e) => at(e.clientX));
    svg.addEventListener('pointerleave', () => { cl.setAttribute('opacity', '0'); cd.setAttribute('opacity', '0'); tip.classList.remove('on'); });
    if (Q.get('hover')) { const r = svg.getBoundingClientRect(); at(r.left + r.width * +Q.get('hover')); }
    return st;
  }

  /* ───────────── the bell: notifications + recent activity (replaces the Activity page) ───────────── */
  const BELL = {
    notes: [
      { id: 'immich', c: 'warn', kind: 'health', t: 'Immich is unhealthy', s: 'Healthcheck failing for 14 min. Auto-heal will try a restart in 1 min.', when: '14 min ago', acked: false, acts: [['Open', 'containers.html?open=immich'], ['Logs', 'containers.html?open=immich']] },
      { id: 'qbit', c: 'fail', kind: 'downtime', t: 'qBittorrent is down', s: 'Stopped 38 min ago. Auto-heal paused after 3 failed restarts.', when: '38 min ago', tg: true, acked: false, acts: [['Restart', 'containers.html?open=qbittorrent'], ['Logs', 'containers.html?open=qbittorrent']] },
      { id: 'updates', c: 'ok', kind: 'update', t: '3 updates available', s: 'Jellyfin, Radarr, Grafana. Nothing is applied automatically.', when: '2 h ago', tg: true, acked: false, acts: [['Review', 'containers.html?filter=updates']] },
      { id: 'paperless', c: 'ok', kind: 'heal', t: 'Auto-heal restarted Paperless', s: 'Healthcheck failed twice; the restart worked and it was healthy again in 38 s.', when: 'yesterday 22:14', tg: true, acked: true, acts: [['Logs', 'containers.html?open=paperless']] },
      { id: 'vw', c: 'ok', kind: 'downtime', t: 'Vaultwarden recovered', s: 'It was down for 6 min after the host rebooted.', when: 'yesterday 12:41', acked: true, acts: [] },
    ],
    acts: [
      { g: 'Today', rows: [
        ['warn', 'Immich became unhealthy', '14:21', 'Healthcheck GET /api/server-info/ping timed out (5 s).'],
        ['fail', 'Auto-heal gave up on qBittorrent (3 of 3)', '14:03', 'Backoff 30 s, 2 min, 8 min. Opt-in toggle stays on; it will retry after you restart it.'],
        ['warn', 'Auto-heal restarted qBittorrent, attempt 2', '13:59', 'Exit code 137 (SIGKILL).'],
        ['fail', 'qBittorrent stopped', '13:57', 'Container exited with code 137.'],
        ['ok', 'Update check finished: 3 available', '12:02', 'Checked 41 images. 2 registries rate-limited and retried.'],
        ['ok', 'Jellyfin recovered after 18 min', '09:30', 'Monitor "Jellyfin HTTP" went slow, then up.'],
        ['off', 'You restarted Sonarr', '07:40', 'From 192.168.1.20 · confirmed in the dialog · took 6 s.'],
      ] },
      { g: 'Yesterday', rows: [
        ['ok', 'Auto-heal restarted Paperless', '22:14', 'Healthy again after 38 s.'],
        ['ok', 'Vaultwarden recovered after 6 min', '12:41', 'Host rebooted at 12:34.'],
        ['off', 'You signed in', '08:02', 'From 192.168.1.20.'],
      ] },
    ],
  };
  const FILTERS = [['all', 'All'], ['needs', 'Needs you'], ['update', 'Updates'], ['heal', 'Auto-heal'], ['downtime', 'Downtime']];
  const unacked = (data) => (data || BELL).notes.filter((n) => !n.acked).length;
  function syncBadge() { const c = unacked(BELL); document.querySelectorAll('[data-bellcount]').forEach((b) => { b.textContent = c; b.style.display = c ? '' : 'none'; }); const bb = document.getElementById('bellbtn'); if (bb) bb.setAttribute('aria-label', c ? 'Notifications, ' + c + ' need you' : 'Notifications, all clear'); }
  function renderBell(root, o) {
    o = o || {}; const data = o.data || BELL, st = root._st || (root._st = { filter: o.filter || 'all', open: o.open || {} });
    const list = data.notes.filter((n) => (st.filter === 'all' || (st.filter === 'needs' ? !n.acked : n.kind === st.filter)));
    const need = list.filter((n) => !n.acked), done = list.filter((n) => n.acked);
    const noteHTML = (n) => '<div class="note' + (n.acked ? ' done' : '') + '" data-id="' + n.id + '"><span class="dot ' + (n.acked ? 'off' : n.c) + '" style="margin-top:6px"></span><div><b>' + n.t + '</b><small>' + n.s + '</small></div><time>' + n.when + (n.tg ? '<br><span class="tg">' + icon('plane', 11) + ' sent</span>' : '') + '</time><div class="acts">' + n.acts.map((a) => '<a href="' + a[1] + '">' + a[0] + '</a>').join('') + (n.acked ? '<span class="ackd">' + icon('check', 12) + ' Acknowledged</span>' : '<button type="button" data-ack="' + n.id + '">Acknowledge</button>') + '</div></div>';
    const actHTML = data.acts.map((g) => '<h3 class="gh">' + g.g + '</h3><div class="act-list">' + g.rows.map((a, i) => { const key = g.g + i, ex = !!st.open[key]; return '<div class="act" data-k="' + key + '"><span class="dot ' + a[0] + '"></span><button type="button" class="at" aria-expanded="' + ex + '"><span>' + a[1] + '</span></button><time>' + a[2] + '</time>' + (ex ? '<small class="ad">' + a[3] + '</small>' : '') + '</div>'; }).join('') + '</div>').join('');
    root.innerHTML =
      (o.filters === false ? '' : '<div class="chips2" role="tablist" aria-label="Filter">' + FILTERS.map((f) => '<button type="button" role="tab" data-f="' + f[0] + '" aria-selected="' + (st.filter === f[0]) + '">' + f[1] + '</button>').join('') + '</div>') +
      (need.length || st.filter === 'all' ? '<h3>Needs you' + (need.length > 1 ? ' <button type="button" class="lnk" data-ackall="1">Acknowledge all</button>' : '') + '</h3>' : '') +
      (need.length ? need.map(noteHTML).join('') : st.filter === 'all' ? '<div class="clear">' + icon('check', 20) + '<b>All clear</b><small>Nothing needs you right now.</small></div>' : '') +
      (done.length ? '<h3 class="sub">Acknowledged</h3>' + done.map(noteHTML).join('') : '') +
      '<h3 class="top">Recent activity <span class="meta" style="text-transform:none;letter-spacing:0">includes your own actions</span></h3>' + actHTML +
      '<div class="more"><button type="button" class="lnk">Show earlier</button></div>';
    if (!root._wired) {
      root._wired = true;
      root.addEventListener('click', (e) => {
        const a = e.target.closest('[data-ack]'), all = e.target.closest('[data-ackall]'), f = e.target.closest('[data-f]'), at = e.target.closest('.at');
        if (a) { const n = data.notes.find((x) => x.id === a.dataset.ack); if (n) n.acked = true; }
        else if (all) { data.notes.forEach((n) => { if (!n.acked) n.acked = true; }); }
        else if (f) { st.filter = f.dataset.f; }
        else if (at) { const k = at.closest('.act').dataset.k; st.open[k] = !st.open[k]; }
        else return;
        renderBell(root, o); syncBadge();
      });
    }
  }
  const cloneBell = (mut) => { const c = JSON.parse(JSON.stringify(BELL)); if (mut) mut(c); return c; };

  /* ───────────── chrome: background, top bar, bell panel, account menu ───────────── */
  const BACKGROUNDS = [
    ['graphite', 'Graphite', 'radial-gradient(circle at 30% 20%, #3a463a, #0b0c0e 70%)'],
    ['dusk', 'Dusk', 'radial-gradient(circle at 70% 20%, #7d5fb2, #0d0b14 72%)'],
    ['forest', 'Forest', 'radial-gradient(circle at 25% 20%, #489070, #0a0f0d 72%)'],
    ['ember', 'Ember', 'radial-gradient(circle at 75% 20%, #d68448, #0f0b09 72%)'],
    ['ridge', 'Ridge', 'linear-gradient(180deg, #2d2e55 20%, #d08a68 85%)'],
    ['city', 'City', 'radial-gradient(circle at 60% 60%, #ffb86a, #060a14 62%)'],
  ];
  const ACCENTS = [['sage', '#8fb389'], ['slate', '#7e93ac'], ['teal', '#69a5a1'], ['amber', '#cfa15e'], ['rose', '#c98189'], ['clay', '#c08a6d'], ['moss', '#93a56f']];
  const store = { get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

  function applyLook() {
    const html = document.documentElement;
    let bg = Q.get('bg') || store.get('opus-mock-bg', 'graphite'); if (!BACKGROUNDS.some((b) => b[0] === bg)) bg = 'graphite';
    let ac = Q.get('accent') || store.get('opus-mock-accent', 'sage'); if (!ACCENTS.some((a) => a[0] === ac)) ac = 'sage';
    html.setAttribute('data-bg', bg); html.setAttribute('data-accent', ac);
  }

  function mountChrome(page, o) {
    o = o || {}; applyLook(); if (o.bare) { const b = document.createElement('div'); b.className = 'bg'; b.setAttribute('aria-hidden', 'true'); b.innerHTML = '<div class="art"></div><div class="scrim"></div><div class="grain"></div>'; document.body.prepend(b); return; }
    const html = document.documentElement, bg = html.getAttribute('data-bg'), ac = html.getAttribute('data-accent'), init = USER.charAt(0).toUpperCase();
    const el = document.createElement('div');
    el.innerHTML =
      '<div class="bg" aria-hidden="true"><div class="art"></div><div class="scrim"></div><div class="grain"></div></div>' +
      '<header class="topbar"><div class="in">' +
        '<a class="brand" href="home.html"><i></i><span>OpusHub</span></a>' +
        '<nav class="nav" aria-label="Main"><a href="home.html"' + (page === 'home' ? ' aria-current="page"' : '') + '>Home</a><a href="containers.html"' + (page === 'containers' ? ' aria-current="page"' : '') + '>Containers</a><a href="uptime.html"' + (page === 'uptime' ? ' aria-current="page"' : '') + '>Uptime</a></nav>' +
        '<div class="grow"></div>' +
        '<button class="tb-btn" aria-label="Search">' + icon('search', 17) + '<kbd>Ctrl K</kbd></button>' +
        '<div class="bell"><button class="tb-btn" id="bellbtn" aria-label="Notifications" aria-expanded="false" aria-controls="bellpanel">' + icon('bell', 18) + '</button><span class="badge" data-bellcount></span></div>' +
        '<button class="av" id="avbtn" aria-label="Account menu for ' + USER + '" aria-haspopup="menu" aria-expanded="false" aria-controls="avmenu"><span>' + init + '</span></button>' +
      '</div></header>' +
      '<section class="panel" id="bellpanel" role="dialog" aria-label="Notifications and recent activity"><div id="bellbody"></div></section>' +
      '<section class="menu" id="avmenu" role="menu" aria-label="Account">' +
        '<div class="mh"><span class="av lg"><span>' + init + '</span></span><div><b>' + USER + '</b><small>Administrator · signed in on this browser</small></div></div>' +
        '<div class="ms"><h4>Appearance</h4>' +
          '<div class="mrow"><span>Theme</span><div class="seg sm" role="group" aria-label="Theme"><button type="button" aria-pressed="false">System</button><button type="button" aria-pressed="true">Dark</button><button type="button" aria-pressed="false" disabled title="Light keeps its flat paper background (not mocked)">Light</button></div></div>' +
          '<div class="mlabel">Background <em id="bgname"></em></div>' +
          '<div class="bggrid" role="group" aria-label="Background">' + BACKGROUNDS.map((b) => '<button class="bgsw" type="button" data-bg="' + b[0] + '" aria-label="' + b[1] + '" aria-pressed="' + (b[0] === bg) + '" style="--swc:' + b[2] + '"><span>' + b[1] + '</span></button>').join('') + '</div>' +
          '<div class="mlabel">Accent</div><div class="acrow" role="group" aria-label="Accent">' + ACCENTS.map((a) => '<button class="acsw" type="button" data-ac="' + a[0] + '" aria-label="' + a[0] + '" aria-pressed="' + (a[0] === ac) + '" style="--c:' + a[1] + '"></button>').join('') + '</div>' +
        '</div>' +
        '<div class="mi"><a role="menuitem" href="settings.html">' + icon('gear', 16) + 'Settings</a><a role="menuitem" href="wizard.html">' + icon('box', 16) + 'First-run wizard (mockup link)</a><a role="menuitem" href="#">' + icon('logout', 16) + 'Sign out</a></div>' +
      '</section>';
    const frag = document.createDocumentFragment(); while (el.firstChild) frag.appendChild(el.firstChild); document.body.prepend(frag);

    const bbtn = document.getElementById('bellbtn'), bpanel = document.getElementById('bellpanel'), abtn = document.getElementById('avbtn'), amenu = document.getElementById('avmenu');
    renderBell(document.getElementById('bellbody')); syncBadge();
    document.getElementById('bgname').textContent = BACKGROUNDS.find((b) => b[0] === bg)[1];
    function setOpen(which, on) {
      const [btn, pn] = which === 'bell' ? [bbtn, bpanel] : [abtn, amenu], [obtn, opn] = which === 'bell' ? [abtn, amenu] : [bbtn, bpanel];
      if (on) { opn.classList.remove('open'); obtn.setAttribute('aria-expanded', 'false'); }
      pn.classList.toggle('open', on); btn.setAttribute('aria-expanded', String(on));
    }
    bbtn.addEventListener('click', (e) => { e.stopPropagation(); setOpen('bell', !bpanel.classList.contains('open')); });
    abtn.addEventListener('click', (e) => { e.stopPropagation(); setOpen('menu', !amenu.classList.contains('open')); });
    document.addEventListener('click', (e) => { if (!bpanel.contains(e.target)) { bpanel.classList.remove('open'); bbtn.setAttribute('aria-expanded', 'false'); } if (!amenu.contains(e.target)) { amenu.classList.remove('open'); abtn.setAttribute('aria-expanded', 'false'); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen('bell', false); setOpen('menu', false); } });
    amenu.querySelectorAll('.bgsw').forEach((b) => b.addEventListener('click', () => { html.setAttribute('data-bg', b.dataset.bg); store.set('opus-mock-bg', b.dataset.bg); amenu.querySelectorAll('.bgsw').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); document.getElementById('bgname').textContent = b.getAttribute('aria-label'); }));
    amenu.querySelectorAll('.acsw').forEach((b) => b.addEventListener('click', () => { html.setAttribute('data-accent', b.dataset.ac); store.set('opus-mock-accent', b.dataset.ac); amenu.querySelectorAll('.acsw').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }));
    if (Q.get('bell') && !o.noPopover) setOpen('bell', true);
    if (Q.get('menu')) setOpen('menu', true);
    const sy = +Q.get('scrollTo'); if (sy) { const go = () => window.scrollTo(0, sy); setTimeout(go, 60); setTimeout(go, 400); }
  }

  window.OPUS = { user: USER, ribbon, STATE_COLOR, rng, hash, icon, STACKS, stackHue, SERVICES, RANGES, buildSeries, stats, currentState, incidents, downMinutes, clock, dayClock, dur, ago, spark, mountChrome, reduce, detail, logs, METRICS, HR, metricSeries, metricStats, bigChart, bell: { data: BELL, render: renderBell, clone: cloneBell, sync: syncBadge, unacked }, BACKGROUNDS, ACCENTS, Q };
})();
