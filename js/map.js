/* Экран «Карта»: Leaflet + тайлы OSM (онлайн) и «радар» на canvas (офлайн). */
(function () {
  'use strict';
  const KG = window.KG;
  const V = (KG.mapView = { root: null, mode: null, forced: null });

  let outline = null, outlineTried = false;
  let L_ready = null, lmap = null, lmarkers = null, lme = null, lacc = null, lfollow = false;
  const el = KG.el;
  let host, leafEl, canvas, ctx, bar, hint, pop, segWrap;
  const CITY = { lat: 48.137, lon: 11.575 };                  // Мариенплац
  const CITY_BOUNDS = [[48.06, 11.36], [48.25, 11.73]];        // запасной вид, пока нет данных и контура
  let view = { lat: CITY.lat, lon: CITY.lon, z: 1500 };       // z — пикселей на градус широты
  let radarFollow = false, dragging = null, pointers = {}, pinch = null, raf = 0, hitList = [];

  const PRIO_COLOR = { 1: '#c8281e', 2: '#e08a1e', 3: '#6b7a90' };
  const ROUTE_COLOR = '#8b46d6';
  let lroute = null, routeChip = null;

  /* Выбранная пешая прогулка (KG.routes.selected()): { r, ps } или null */
  function routePts() {
    const id = KG.routes && KG.routes.selected();
    const r = id && KG.data.routeById[id];
    if (!r) return null;
    const ps = KG.data.routeStops(r);
    return ps.length >= 2 ? { r: r, ps: ps } : null;
  }

  function paintRouteChip() {
    if (!routeChip) return;
    KG.clear(routeChip);
    const rt = routePts();
    const was = routeChip._on;
    routeChip._on = !!rt;
    routeChip.hidden = !rt;
    if (rt) {
      routeChip.appendChild(el('a', { class: 'map-route-l', href: '#/route/' + encodeURIComponent(rt.r.id) }, KG.icon('route'), el('span', { text: rt.r.title })));
      routeChip.appendChild(el('button', { class: 'map-route-x', type: 'button', 'aria-label': 'Скрыть маршрут с карты', onclick: function () { KG.routes.select(null); } }, KG.icon('close')));
    }
    /* высота панели над картой изменилась — пересчитать размеры карты/радара */
    if (was !== routeChip._on && V.active && canvas && canvas._w) {
      setTimeout(function () { if (lmap) lmap.invalidateSize(); if (canvas.style.display !== 'none') { resizeCanvas(); schedule(); } }, 0);
    }
  }

  function buildRoute() {
    paintRouteChip();
    if (!lroute) return;
    lroute.clearLayers();
    const rt = routePts();
    if (!rt) return;
    lroute.addLayer(L.polyline(rt.ps.map(function (p) { return [p.lat, p.lon]; }), { color: ROUTE_COLOR, weight: 5, opacity: 0.85, lineJoin: 'round', interactive: false }));
    rt.ps.forEach(function (p, i) {
      const icon = L.divIcon({ className: 'pin-wrap', html: '<span class="rt-pin">' + (i + 1) + '</span>', iconSize: [28, 28], iconAnchor: [14, 14] });
      const m = L.marker([p.lat, p.lon], { icon: icon, title: (i + 1) + '. ' + KG.data.name(p), keyboard: false, zIndexOffset: 500 });
      m.on('click', function () { popupFor(p); });
      lroute.addLayer(m);
    });
  }

  function fitRoute() {
    const rt = routePts();
    if (!rt) return;
    if (V.mode === 'map' && lmap) {
      lmap.fitBounds(L.latLngBounds(rt.ps.map(function (p) { return [p.lat, p.lon]; })), { padding: [40, 40], maxZoom: 17 });
    } else {
      let s = 90, n = -90, w = 180, e = -180;
      rt.ps.forEach(function (p) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); });
      const cw = canvas._w || 300, ch = canvas._h || 400;
      const dLat = Math.max(0.004, n - s) * 1.3, dLon = Math.max(0.006, e - w) * COS * 1.3;
      view.z = Math.max(Z_MIN, Math.min(Z_MAX, Math.min(cw / dLon, ch / dLat)));
      view.lat = (n + s) / 2; view.lon = (e + w) / 2; view.init = true; radarFollow = false;
      schedule();
    }
  }
  /* «Показать маршрут на карте» из экрана прогулки: после показа вкладки — приблизить к маршруту */
  function afterShow() { if (V.fitNext) { V.fitNext = false; fitRoute(); } }

  V.init = function (root) {
    V.root = root;
    leafEl = el('div', { id: 'leaflet', class: 'leaflet-host' });
    canvas = el('canvas', { id: 'radar', class: 'radar', 'aria-label': 'Схема мест на контуре Мюнхена' });
    pop = el('div', { class: 'map-pop', hidden: true });
    hint = el('div', { class: 'map-hint', hidden: true });
    segWrap = el('div', { class: 'map-seg' });
    const locate = el('button', { class: 'map-fab', type: 'button', 'aria-label': 'Моё положение', onclick: locateMe }, KG.icon('crosshair'));
    const fit = el('button', { class: 'map-fab fit', type: 'button', 'aria-label': 'Весь город', onclick: fitCity, text: 'Весь город' });
    host = el('div', { class: 'map-host' }, leafEl, canvas, hint, pop, el('div', { class: 'map-fabs' }, fit, locate));
    routeChip = el('div', { class: 'map-route', hidden: true });
    bar = el('div', { class: 'map-bar' }, segWrap, routeChip);
    root.appendChild(bar);
    root.appendChild(host);
    drawSeg();
    ctx = canvas.getContext('2d');
    bindRadar();
    window.addEventListener('resize', function () { if (V.active) { resizeCanvas(); schedule(); if (lmap) lmap.invalidateSize(); } });
    window.addEventListener('online', autoMode);
    window.addEventListener('offline', autoMode);
    KG.on('fix', function () { if (V.active) updateMe(); });
    KG.on('data', function () { if (lmarkers) buildMarkers(); buildRoute(); schedule(); });
    KG.on('route-sel', function () { buildRoute(); schedule(); });
    paintRouteChip();
    KG.on('history', function () { if (lmarkers) buildMarkers(); });
  };

  function drawSeg() {
    KG.clear(segWrap);
    segWrap.appendChild(KG.segmented([{ value: 'map', label: 'Карта' }, { value: 'radar', label: 'Радар (офлайн)' }], V.mode || 'radar', function (v) { V.forced = v; setMode(v); }));
  }

  function autoMode() {
    if (!V.active) return;
    if (!V.forced) setMode(navigator.onLine ? 'map' : 'radar');
  }

  V.show = function () {
    V.active = true;
    if (!V.forced) V.mode = navigator.onLine ? 'map' : 'radar';
    setMode(V.mode, true);
  };
  V.hide = function () { V.active = false; };

  async function setMode(mode, initial) {
    V.mode = mode;
    drawSeg();
    leafEl.style.display = mode === 'map' ? 'block' : 'none';
    canvas.style.display = mode === 'radar' ? 'block' : 'none';
    hint.hidden = true; pop.hidden = true;
    if (mode === 'map') {
      try { await initLeaflet(); } catch (e) {
        KG.log('warn', 'leaflet: ' + e.message);
        hint.textContent = 'Карту загрузить не удалось — показан радар.'; hint.hidden = false;
        V.mode = 'radar'; drawSeg(); leafEl.style.display = 'none'; canvas.style.display = 'block';
        await showRadar(initial);
        afterShow();
        return;
      }
      lmap.invalidateSize();
      updateMe();
      if (!navigator.onLine) { hint.textContent = 'Нет сети: плитки карты не загрузятся. Откройте «Радар».'; hint.hidden = false; }
      afterShow();
    } else { await showRadar(initial); afterShow(); }
  }

  /* ---------- Leaflet ---------- */
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (L_ready) return L_ready;
    L_ready = new Promise(function (resolve, reject) {
      const css = el('link', { rel: 'stylesheet', href: 'js/vendor/leaflet/leaflet.css' });
      document.head.appendChild(css);
      const s = el('script', { src: 'js/vendor/leaflet/leaflet.js' });
      s.onload = resolve;
      s.onerror = function () { L_ready = null; reject(new Error('leaflet.js не загрузился')); };
      document.head.appendChild(s);
    });
    return L_ready;
  }

  async function initLeaflet() {
    await loadLeaflet();
    if (lmap) return;
    lmap = L.map(leafEl, { zoomControl: false, attributionControl: true, worldCopyJump: false, tap: true }).setView([CITY.lat, CITY.lon], 12);
    L.control.zoom({ position: 'topleft' }).addTo(lmap);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
    }).addTo(lmap);
    let errs = 0;
    tiles.on('tileerror', function () { if (++errs === 6) { hint.textContent = 'Плитки карты не загружаются (нет сети?). Откройте «Радар».'; hint.hidden = false; } });
    tiles.on('tileload', function () { errs = 0; hint.hidden = true; });
    lmarkers = L.layerGroup().addTo(lmap);
    buildMarkers();
    lroute = L.layerGroup().addTo(lmap);
    buildRoute();
    lmap.on('dragstart', function () { lfollow = false; });
    lmap.fitBounds(boundsOfPois() || CITY_BOUNDS, { padding: [30, 30], maxZoom: 14 });
    if (KG.gps.last) { lmap.setView([KG.gps.last.lat, KG.gps.last.lon], 14); }
  }

  function boundsOfPois() {
    const ps = KG.data.pois;
    if (!ps.length) return null;
    return L.latLngBounds(ps.map(function (p) { return [p.lat, p.lon]; }));
  }

  function buildMarkers() {
    if (!lmarkers) return;
    lmarkers.clearLayers();
    KG.data.pois.forEach(function (p) {
      const icon = L.divIcon({ className: 'pin-wrap', html: '<span class="pin p' + p.priority + (KG.guide.isDone(p.id) ? ' done' : '') + '"></span>', iconSize: [26, 26], iconAnchor: [13, 13] });
      const m = L.marker([p.lat, p.lon], { icon: icon, title: KG.data.name(p), keyboard: false });
      m.on('click', function () { popupFor(p); });
      lmarkers.addLayer(m);
    });
  }

  function updateMe() {
    const f = KG.gps.last;
    if (lmap && f) {
      if (!lme) {
        lme = L.marker([f.lat, f.lon], { icon: L.divIcon({ className: 'me-wrap', html: '<span class="me"><i></i></span>', iconSize: [28, 28], iconAnchor: [14, 14] }), interactive: false, zIndexOffset: 1000 }).addTo(lmap);
        lacc = L.circle([f.lat, f.lon], { radius: f.acc || 20, weight: 1, color: '#2a6fdb', fillOpacity: 0.1, interactive: false }).addTo(lmap);
      }
      lme.setLatLng([f.lat, f.lon]);
      lacc.setLatLng([f.lat, f.lon]); lacc.setRadius(Math.max(5, f.acc || 20));
      const h = KG.gps.heading();
      const node = lme.getElement();
      if (node) { const i = node.querySelector('i'); if (i) { i.style.transform = 'rotate(' + (h || 0) + 'deg)'; i.style.display = h == null ? 'none' : 'block'; } }
      if (lfollow) lmap.panTo([f.lat, f.lon], { animate: true });
    }
    if (V.mode === 'radar') { if (radarFollow && f) { view.lat = f.lat; view.lon = f.lon; } schedule(); }
  }

  function popupFor(p) {
    const d = KG.gps.last ? KG.fmtDist(KG.geo.dist(KG.gps.last, p)) : '';
    KG.clear(pop);
    pop.appendChild(el('div', { class: 'map-pop-t' }, el('b', { text: KG.data.name(p) }), el('span', { class: 'muted', text: [KG.data.catLabel(p.category), d].filter(Boolean).join(' · ') })));
    pop.appendChild(el('button', { class: 'btn primary', type: 'button', text: 'Открыть', onclick: function () { location.hash = '#/poi/' + p.id; } }));
    pop.appendChild(el('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Закрыть', onclick: function () { pop.hidden = true; } }, KG.icon('close')));
    pop.hidden = false;
  }

  function locateMe() {
    const f = KG.gps.last;
    if (!f) { KG.toast('Положение ещё не определено'); return; }
    if (V.mode === 'map' && lmap) { lfollow = true; lmap.setView([f.lat, f.lon], Math.max(lmap.getZoom(), 15)); } else {
      radarFollow = true; view.lat = f.lat; view.lon = f.lon; view.z = Math.max(view.z, 12000); schedule();
    }
  }
  function fitCity() {
    lfollow = false; radarFollow = false;
    if (V.mode === 'map' && lmap) lmap.fitBounds(boundsOfPois() || CITY_BOUNDS, { padding: [30, 30], maxZoom: 14 });
    else { fitRadar(); schedule(); }
  }

  /* ---------- радар ---------- */
  async function loadOutline() {
    if (outline || outlineTried) return outline;
    outlineTried = true;
    try { outline = await KG.fetchJson('data/mg-outline.json', 10000); } catch (e) { KG.log('warn', 'outline: ' + e.message); }
    return outline;
  }

  function resizeCanvas() {
    const r = host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas._w = r.width; canvas._h = r.height; canvas._dpr = dpr;
  }

  /* Рамка вида: все места плюс контур города; пока ничего нет — центр Мюнхена. */
  function dataBounds() {
    let s = 90, n = -90, w = 180, e = -180, any = false;
    const add = function (lat, lon) { any = true; s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon); };
    KG.data.pois.forEach(function (p) { add(p.lat, p.lon); });
    if (outline && outline.country) outline.country.forEach(function (r) { r.forEach(function (pt) { add(pt[1], pt[0]); }); });
    if (!any) return { s: CITY_BOUNDS[0][0], w: CITY_BOUNDS[0][1], n: CITY_BOUNDS[1][0], e: CITY_BOUNDS[1][1] };
    return { s: s, n: n, w: w, e: e };
  }

  function fitRadar() {
    const w = canvas._w || 300, h = canvas._h || 400, b = dataBounds();
    const dLat = Math.max(0.02, b.n - b.s) * 1.12, dLon = Math.max(0.03, b.e - b.w) * COS * 1.12;
    view.z = Math.max(Z_MIN, Math.min(w / dLon, h / dLat));
    view.lat = (b.n + b.s) / 2; view.lon = (b.e + b.w) / 2;
  }

  async function showRadar(initial) {
    resizeCanvas();
    await loadOutline();
    resizeCanvas();
    if (initial || !view.init) { fitRadar(); view.init = true; }
    schedule();
  }

  const COS = Math.cos(CITY.lat * Math.PI / 180);
  const Z_MIN = 300, Z_MAX = 90000;
  function toScreen(lat, lon) {
    return [canvas._w / 2 + (lon - view.lon) * COS * view.z, canvas._h / 2 - (lat - view.lat) * view.z];
  }

  function schedule() { if (V.mode !== 'radar' || raf) return; raf = requestAnimationFrame(function () { raf = 0; drawRadar(); }); }

  function css(name, def) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || def; }

  function drawRadar() {
    if (!ctx || !canvas._w) return;
    const dpr = canvas._dpr, w = canvas._w, h = canvas._h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css('--map-bg', '#e9eef5'); ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1; ctx.strokeStyle = css('--map-grid', 'rgba(0,0,0,.08)'); ctx.fillStyle = css('--muted', '#667');
    ctx.font = '11px system-ui, sans-serif';
    /* шаг сетки: ближайший «круглый» шаг, при котором линии не гуще ~70 пикселей */
    const step = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5].find(function (s) { return s * view.z >= 70; }) || 0.5;
    const dec = step < 0.01 ? 3 : step < 0.1 ? 2 : 1;
    const a = [view.lat + h / 2 / view.z, view.lon - w / 2 / (view.z * COS)], b = [view.lat - h / 2 / view.z, view.lon + w / 2 / (view.z * COS)];
    for (let lon = Math.ceil(a[1] / step) * step; lon <= b[1]; lon += step) {
      const x = toScreen(0, lon)[0]; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(lon.toFixed(dec) + '°', x + 3, h - 4);
    }
    for (let lat = Math.ceil(b[0] / step) * step; lat <= a[0]; lat += step) {
      const y = toScreen(lat, 0)[1]; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(lat.toFixed(dec) + '°', 4, y - 3);
    }
    if (outline) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      outline.country.forEach(function (ring) {
        ctx.beginPath();
        ring.forEach(function (pt, i) { const s = toScreen(pt[1], pt[0]); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
        ctx.closePath();
        ctx.fillStyle = css('--map-land', '#f8f4ea'); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = css('--map-border', '#0d4a7a'); ctx.stroke();
      });
      ctx.fillStyle = css('--map-water', '#a9d6f2');
      (outline.lakes || []).forEach(function (lk) {
        ctx.beginPath();
        lk.ring.forEach(function (pt, i) { const s = toScreen(pt[1], pt[0]); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
        ctx.closePath(); ctx.fill();
      });
      ctx.strokeStyle = css('--map-river', '#6db3e4'); ctx.lineWidth = Math.max(2.5, Math.min(9, view.z / 1800));
      (outline.rivers || []).forEach(function (rv) {
        ctx.beginPath();
        rv.line.forEach(function (pt, i) { const s = toScreen(pt[1], pt[0]); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
        ctx.stroke();
      });
      if (view.z > 2500) {
        ctx.fillStyle = css('--map-river-label', '#4a86b0'); ctx.font = 'italic 12px system-ui, sans-serif'; ctx.textBaseline = 'middle';
        const named = {};
        (outline.rivers || []).forEach(function (rv) {
          if (!rv.name || named[rv.name] || rv.line.length < 2) return;
          const pt = rv.line[Math.floor(rv.line.length / 2)], s = toScreen(pt[1], pt[0]);
          if (s[0] > 10 && s[1] > 10 && s[0] < w - 40 && s[1] < h - 10) { ctx.fillText(rv.name, s[0] + 8, s[1]); named[rv.name] = 1; }
        });
      }
    }
    /* выбранная пешая прогулка: линия под местами */
    const rt = routePts();
    if (rt) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = 5; ctx.strokeStyle = ROUTE_COLOR; ctx.globalAlpha = 0.85;
      ctx.beginPath();
      rt.ps.forEach(function (p, i) { const s = toScreen(p.lat, p.lon); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    /* места */
    hitList = [];
    const showLabels = view.z > 1500;
    ctx.textBaseline = 'middle';
    KG.data.pois.slice().sort(function (p, q) { return q.priority - p.priority; }).forEach(function (p) {
      const s = toScreen(p.lat, p.lon);
      if (s[0] < -20 || s[1] < -20 || s[0] > w + 20 || s[1] > h + 20) return;
      const r = p.priority === 1 ? 7 : p.priority === 2 ? 5.5 : 4.5;
      ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, 6.2832);
      ctx.fillStyle = PRIO_COLOR[p.priority] || '#666'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = KG.guide.isDone(p.id) ? '#2e7d4f' : '#fff'; ctx.stroke();
      hitList.push({ p: p, x: s[0], y: s[1] });
      if (showLabels && (p.priority === 1 || view.z > 6000)) {
        ctx.font = (p.priority === 1 ? '600 ' : '') + '12px system-ui, sans-serif';
        const t = KG.data.name(p);
        ctx.lineWidth = 3; ctx.strokeStyle = css('--map-land', '#fff'); ctx.strokeText(t, s[0] + r + 4, s[1]);
        ctx.fillStyle = css('--ink', '#111'); ctx.fillText(t, s[0] + r + 4, s[1]);
      }
    });
    /* номера остановок прогулки поверх мест */
    if (rt) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '700 13px system-ui, sans-serif';
      rt.ps.forEach(function (p, i) {
        const s = toScreen(p.lat, p.lon);
        if (s[0] < -20 || s[1] < -20 || s[0] > w + 20 || s[1] > h + 20) return;
        ctx.beginPath(); ctx.arc(s[0], s[1], 12, 0, 6.2832); ctx.fillStyle = ROUTE_COLOR; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.fillText(String(i + 1), s[0], s[1] + 0.5);
      });
      ctx.textAlign = 'start';
    }
    /* я */
    const f = KG.gps.last;
    if (f) {
      const s = toScreen(f.lat, f.lon);
      const ar = Math.max(8, (f.acc || 20) / 111000 * view.z);
      ctx.beginPath(); ctx.arc(s[0], s[1], ar, 0, 6.2832); ctx.fillStyle = 'rgba(42,111,219,.15)'; ctx.fill();
      const hd = KG.gps.heading();
      if (hd != null) {
        ctx.save(); ctx.translate(s[0], s[1]); ctx.rotate(hd * Math.PI / 180);
        ctx.beginPath(); ctx.moveTo(0, -22); ctx.lineTo(8, -6); ctx.lineTo(-8, -6); ctx.closePath(); ctx.fillStyle = '#2a6fdb'; ctx.fill(); ctx.restore();
      }
      ctx.beginPath(); ctx.arc(s[0], s[1], 7, 0, 6.2832); ctx.fillStyle = '#2a6fdb'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
    /* масштабная линейка */
    const km = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50].find(function (k) { return k / 111 * view.z * COS > 60; }) || 50;
    const len = km / 111 * view.z * COS;
    ctx.strokeStyle = css('--ink', '#111'); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(12, h - 22); ctx.lineTo(12 + len, h - 22); ctx.stroke();
    ctx.fillStyle = css('--ink', '#111'); ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(km < 1 ? Math.round(km * 1000) + ' м' : km + ' км', 12, h - 28);
    if (!outline) { ctx.fillText('Контур города не загружен', 12, 24); }
  }

  function bindRadar() {
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: Date.now() };
      if (Object.keys(pointers).length === 2) { const ps = Object.values(pointers); pinch = { d: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), z: view.z }; }
    });
    canvas.addEventListener('pointermove', function (e) {
      const p = pointers[e.pointerId];
      if (!p) return;
      if (pinch && Object.keys(pointers).length >= 2) {
        p.x = e.clientX; p.y = e.clientY;
        const ps = Object.values(pointers);
        const d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
        view.z = Math.max(Z_MIN, Math.min(Z_MAX, pinch.z * d / pinch.d)); radarFollow = false; schedule();
        return;
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      view.lon -= dx / (view.z * COS); view.lat += dy / view.z; radarFollow = false; schedule();
    });
    const up = function (e) {
      const p = pointers[e.pointerId];
      delete pointers[e.pointerId];
      if (Object.keys(pointers).length < 2) pinch = null;
      if (p && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 8 && Date.now() - p.t < 500) tapAt(e);
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', function (e) { delete pointers[e.pointerId]; pinch = null; });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      view.z = Math.max(Z_MIN, Math.min(Z_MAX, view.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2))); schedule();
    }, { passive: false });
    canvas.addEventListener('dblclick', function () { view.z = Math.min(Z_MAX, view.z * 1.6); schedule(); });
  }

  function tapAt(e) {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 28;
    hitList.forEach(function (h) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h; } });
    if (best) popupFor(best.p); else pop.hidden = true;
  }

  V.refresh = function () { schedule(); };
  KG.on('settings', function () { schedule(); });
})();
