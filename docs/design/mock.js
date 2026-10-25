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
  const BACKGROUNDS = [
    ['graphite', 'Graphite', 'radial-gradient(circle at 30% 20%, #3a463a, #0b0c0e 70%)'],
    ['dusk', 'Dusk', 'radial-gradient(circle at 70% 20%, #7d5fb2, #0d0b14 72%)'],
    ['forest', 'Forest', 'radial-gradient(circle at 25% 20%, #489070, #0a0f0d 72%)'],
    ['ember', 'Ember', 'radial-gradient(circle at 75% 20%, #d68448, #0f0b09 72%)'],
    ['ridge', 'Ridge (photo stand-in)', 'linear-gradient(180deg, #2d2e55, #d08a68)'],
    ['city', 'City (photo stand-in)', 'radial-gradient(circle at 60% 60%, #ffb86a, #060a14 62%)'],
  ];

  const NOTES = [
    { c: 'warn', t: 'Immich is unhealthy', s: 'Healthcheck failing for 14 min. Auto-heal will try a restart in 1 min.', when: '14 min', acts: [['Open', '#'], ['Acknowledge']] },
    { c: 'fail', t: 'qBittorrent is down', s: 'Stopped 38 min ago. Auto-heal paused after 3 failed restarts.', when: '38 min', tg: true, acts: [['Restart', '#'], ['Logs', '#'], ['Acknowledge']] },
    { c: 'ok', t: '3 updates available', s: 'Jellyfin, Radarr, Grafana. Nothing is applied automatically.', when: '2 h', tg: true, acts: [['Review', '#']] },
  ];
  const ACTS = [
    ['warn', 'Immich became unhealthy', '14:21'],
    ['fail', 'Auto-heal gave up on qBittorrent (3 of 3)', '14:03'],
    ['warn', 'Auto-heal restarted qBittorrent, attempt 2', '13:59'],
    ['fail', 'qBittorrent stopped (exit 137)', '13:57'],
    ['ok', 'Update check finished: 3 available', '12:02'],
    ['ok', 'Jellyfin recovered after 18 min', '09:30'],
    ['off', 'You restarted Sonarr', '07:40'],
  ];

  function mountChrome(page) {
    const html = document.documentElement;
    let bg = 'graphite'; try { bg = localStorage.getItem('opus-mock-bg') || bg; } catch (e) { /* private mode */ }
    const qbg = new URLSearchParams(location.search).get('bg'); if (qbg) bg = qbg;   // ?bg=ridge for screenshots and links
    if (!BACKGROUNDS.some((b) => b[0] === bg)) bg = 'graphite';
    html.setAttribute('data-bg', bg);

    const el = document.createElement('div');
    el.innerHTML =
      '<div class="bg" aria-hidden="true"><div class="art"></div><div class="scrim"></div><div class="grain"></div></div>' +
      '<header class="topbar"><div class="in">' +
        '<a class="brand" href="home.html"><i></i><span>OpusHub</span></a>' +
        '<nav class="nav" aria-label="Main"><a href="home.html"' + (page === 'home' ? ' aria-current="page"' : '') + '>Home</a><a href="#">Containers</a><a href="uptime.html"' + (page === 'uptime' ? ' aria-current="page"' : '') + '>Uptime</a></nav>' +
        '<div class="grow"></div>' +
        '<button class="tb-btn" aria-label="Search">' + icon('search', 17) + '<kbd>Ctrl K</kbd></button>' +
        '<div class="bell"><button class="tb-btn" id="bellbtn" aria-label="Notifications, 3 need attention" aria-expanded="false" aria-controls="bellpanel">' + icon('bell', 18) + '</button><span class="badge">3</span></div>' +
        '<button class="tb-btn" aria-label="Settings">' + icon('gear', 18) + '</button>' +
      '</div>' +
'</header>' +
      '<section class="panel" id="bellpanel" role="dialog" aria-label="Notifications and recent activity">' +
        '<h3>Needs you <a href="#">Mark all read</a></h3>' +
        NOTES.map((n) => '<div class="note"><span class="dot ' + n.c + '" style="margin-top:6px"></span><div><b>' + n.t + '</b><small>' + n.s + '</small></div><time>' + n.when + ' ago' + (n.tg ? '<br><span class="tg">' + icon('plane', 11) + ' sent</span>' : '') + '</time><div class="acts">' + n.acts.map((a) => a[1] ? '<a href="' + a[1] + '">' + a[0] + '</a>' : '<button type="button">' + a[0] + '</button>').join('') + '</div></div>').join('') +
        '<h3 style="margin-top:6px">Recent activity <span class="meta" style="text-transform:none;letter-spacing:0">today</span></h3>' +
        '<div class="act-list">' + ACTS.map((a) => '<div class="act"><span class="dot ' + a[0] + '"></span><span>' + a[1] + '</span><time>' + a[2] + '</time></div>').join('') + '</div>' +
      '</section>' +
      '<div class="dock" role="group" aria-label="Mockup only: preview a built-in background"><span>Background</span>' +
        BACKGROUNDS.map((b) => '<button class="sw" type="button" data-bg="' + b[0] + '" title="' + b[1] + '" aria-label="' + b[1] + '" aria-pressed="' + (b[0] === bg) + '" style="--swc:' + b[2] + '"></button>').join('') + '</div>';
    const frag = document.createDocumentFragment();
    while (el.firstChild) frag.appendChild(el.firstChild);
    document.body.prepend(frag);

    const btn = document.getElementById('bellbtn'), panel = document.getElementById('bellpanel');
    function setOpen(o) { panel.classList.toggle('open', o); btn.setAttribute('aria-expanded', String(o)); }
    btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!panel.classList.contains('open')); });
    if (new URLSearchParams(location.search).get('bell')) setOpen(true);   // ?bell=1 opens the panel (screenshots, links)
    document.addEventListener('click', (e) => { if (!panel.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    panel.querySelectorAll('.note button').forEach((b) => b.addEventListener('click', () => { const n = b.closest('.note'); n.style.transition = 'opacity .25s, transform .25s'; n.style.opacity = '.35'; b.textContent = 'Acknowledged'; b.disabled = true; }));
    document.querySelectorAll('.dock .sw').forEach((b) => b.addEventListener('click', () => {
      html.setAttribute('data-bg', b.dataset.bg); try { localStorage.setItem('opus-mock-bg', b.dataset.bg); } catch (e) { /* ignore */ }
      document.querySelectorAll('.dock .sw').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
  }

  window.OPUS = { ribbon, STATE_COLOR, rng, hash, icon, STACKS, stackHue, SERVICES, RANGES, buildSeries, stats, currentState, incidents, downMinutes, clock, dayClock, dur, ago, spark, mountChrome, reduce };
})();
