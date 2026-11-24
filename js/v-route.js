/* Пешие прогулки: плашка со списком маршрутов, экран маршрута (#/route/<id>), пошаговый режим «Начать прогулку».
   Данные — data/routes.json (KG.data.routes); на карте маршрут рисует map.js (KG.routes.selected()). */
(function () {
  'use strict';
  const KG = window.KG, el = KG.el, U = KG.ui, D = KG.data;
  const R = (KG.routes = {});

  const DETOUR = 1.3;       // прямая между остановками × 1,3 ≈ реальный путь по улицам
  const WALK_KMH = 4;       // скорость шага
  const STOP_MIN = 6;       // минут на остановку (послушать рассказ, осмотреться)
  const HERE_M = 40;        // ближе этого — «вы на месте»

  const isApple = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
  const isAndroid = /Android/.test(navigator.userAgent);

  /* ---------- расчёты ---------- */
  R.stops = function (r) { return D.routeStops(r); };

  /* legs[k] — примерный пеший путь от остановки k-1 до k, м (legs[0] = 0) */
  R.legs = function (stops) {
    return stops.map(function (p, k) { return k ? KG.geo.dist(stops[k - 1], p) * DETOUR : 0; });
  };

  R.stats = function (r) {
    const stops = R.stops(r), legs = R.legs(stops);
    const meters = legs.reduce(function (s, x) { return s + x; }, 0);
    const minutes = meters / 1000 / WALK_KMH * 60 + stops.length * STOP_MIN;
    return { n: stops.length, meters: meters, minutes: minutes };
  };

  R.fmtMinutes = function (min) {
    if (min < 60) return '≈ ' + Math.max(5, Math.round(min / 5) * 5) + ' мин';
    const h = Math.round(min / 30) / 2;
    return '≈ ' + String(h).replace('.', ',') + ' ч';
  };

  R.estimate = function (st) {
    return '≈ ' + KG.fmtDist(st.meters).replace(' ', ' ') + ' пешком, ' + R.fmtMinutes(st.minutes) + ' с остановками';
  };

  const stopsWord = function (n) { return n + ' ' + KG.plural(n, ['остановка', 'остановки', 'остановок']); };

  /* ---------- выбранный на карте маршрут и прогресс ---------- */
  R.selected = function () {
    const id = KG.store.get('routeSel', null);
    return id && D.routeById[id] ? id : null;
  };
  R.select = function (id) {
    if (id) KG.store.set('routeSel', id); else KG.store.del('routeSel');
    KG.emit('route-sel', id || null);
  };
  const progOf = function (id) {
    const p = KG.store.get('route.' + id, null);
    return { on: !!(p && p.on), i: p && isFinite(p.i) ? Math.max(0, Math.floor(p.i)) : 0 };
  };
  const saveProg = function (id, on, i) { KG.store.set('route.' + id, { on: !!on, i: i }); };

  R.showOnMap = function (id) {
    R.select(id);
    if (KG.mapView) KG.mapView.fitNext = true;
    U.closeSheet(true);
    location.hash = '#/map';
  };

  /* ---------- плашка «Пешие прогулки» (каталог, «Рядом») ---------- */
  R.banner = function (region, o) {
    o = o || {};
    const rs = D.routesFor(region);
    if (!rs.length) return null;
    const items = rs.map(function (r) {
      const st = R.stats(r);
      return el('a', { class: 'rt-ban-item', href: '#/route/' + encodeURIComponent(r.id) },
        el('span', { class: 'rt-ban-t' }, el('b', { text: r.title }),
          el('span', { text: stopsWord(st.n) + ' · ' + (o.compact ? '≈ ' + KG.fmtDist(st.meters).replace(' ', ' ') : R.estimate(st).replace(' с остановками', '')) })),
        el('span', { class: 'rt-ban-go', 'aria-hidden': 'true', text: '→' }));
    });
    return el('section', { class: 'rt-ban' + (o.compact ? ' compact' : ''), 'aria-label': o.title || 'Пешие прогулки' },
      el('div', { class: 'rt-ban-h' }, KG.icon('route'), el('b', { text: o.title || 'Пешие прогулки' })),
      o.compact ? null : el('div', { class: 'rt-ban-sub', text: 'Что смотреть: места по порядку, с расстоянием, картой и рассказом на каждой остановке.' }),
      items);
  };

  /* ---------- экран маршрута ---------- */
  let cur = null;   // { id, subs, perm, onHash }

  function cleanup() {
    if (!cur) return;
    cur.subs.forEach(function (f) { f(); });
    cur.perm.forEach(function (f) { f(); });
    window.removeEventListener('hashchange', cur.onHash);
    cur = null;
  }
  R.cleanup = cleanup;

  function navUrls(stops, idx) {
    const a = stops[0], b = stops[1];
    const pair = stops.length === 2;
    const dest = pair ? b : stops[idx], src = pair ? a : null;
    const ll = function (p) { return p.lat + ',' + p.lon; };
    const apple = (isApple ? 'maps://' : 'https://maps.apple.com/') + '?' + (src ? 'saddr=' + ll(src) + '&' : '') + 'daddr=' + ll(dest) + '&dirflg=w';
    const appleWeb = 'https://maps.apple.com/?' + (src ? 'saddr=' + ll(src) + '&' : '') + 'daddr=' + ll(dest) + '&dirflg=w';
    const google = 'https://www.google.com/maps/dir/?api=1' + (src ? '&origin=' + ll(src) : '') + '&destination=' + ll(dest) + '&travelmode=walking';
    const osm = 'https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=' + (src ? ll(src) : '') + ';' + ll(dest);
    return { primary: isApple ? apple : isAndroid ? google : osm, appleWeb: appleWeb, google: google, dest: dest, pair: pair };
  }

  R.open = function (id) {
    KG.card.cleanup();
    cleanup();
    const r = D.routeById[id];
    if (!r || R.stops(r).length < 2) {
      U.openSheet('Прогулка не найдена', U.empty('Такого маршрута нет. Возможно, данные обновились.', el('a', { class: 'btn primary', href: '#/catalog', text: 'В каталог' })));
      return;
    }
    const prog = progOf(id);
    const S = { id: id, walk: prog.on, i: prog.i };
    const wrap = el('div', { class: 'card-page rt-page' });
    cur = { id: id, subs: [], perm: [], onHash: null };
    cur.onHash = function () { if (!/^#\/route\//.test(location.hash)) cleanup(); };
    window.addEventListener('hashchange', cur.onHash);
    U.openSheet('Пешая прогулка', wrap);
    U.onClose = cleanup;
    U.cardKey = null;
    const me = cur;
    const sub = function (evt, fn) { me.subs.push(KG.on(evt, fn)); };
    me.perm.push(KG.on('data', function () { if (cur === me) paint(); }));

    const live = function () { return !!KG.guide.pos && (KG.gps.state === 'ok' || KG.gps.state === 'sim'); };

    function whereBox(p) {
      const box = el('div', { class: 'rt-where' });
      const upd = function () {
        KG.clear(box);
        if (!live()) {
          box.appendChild(el('span', { class: 'muted', text: 'Нет геопозиции: идите по списку. Включите GPS (вкладка «Рядом»), чтобы видеть расстояние и направление.' }));
          return;
        }
        const f = KG.guide.pos, d = KG.geo.dist(f, p), brg = KG.geo.bearing(f, p), h = KG.gps.heading();
        const rel = h !== null && h !== undefined ? KG.geo.diff(brg, h) : brg;
        if (d <= HERE_M) box.appendChild(el('span', { class: 'rt-here' }, KG.icon('check'))); else box.appendChild(U.arrow(rel));
        box.appendChild(el('div', { class: 'rt-where-t' },
          el('b', { text: d <= HERE_M ? 'Вы на месте' : KG.fmtDist(d) + ' · на ' + KG.compassWord(brg) }),
          d <= HERE_M ? null : el('span', { class: 'muted', text: h !== null && h !== undefined ? 'Стрелка: вверх — прямо по ходу' : 'Стрелка вверх — север (курс пока не известен)' })));
      };
      upd();
      sub('fix', upd);
      return box;
    }

    function playBtn(p) {
      const P = KG.player;
      const mine = function () { return P.track && P.track.key === p.id && P.state !== 'idle'; };
      const b = el('button', { class: 'btn accent xl wide', type: 'button', onclick: function () {
        if (mine()) { P.toggle(); return; }
        P.unlock();
        const t = KG.guide.trackFor(p, null);
        P.play(t);
        KG.guide.markIfPoi(t);
      } });
      const upd = function () {
        KG.clear(b);
        const on = mine(), playing = on && (P.state === 'playing' || P.state === 'loading');
        b.appendChild(KG.icon(playing ? 'pause' : 'play'));
        b.appendChild(el('span', { text: playing ? 'Пауза' : on ? 'Продолжить рассказ' : 'Рассказать' }));
      };
      upd();
      sub('player', upd); sub('track', upd);
      return b;
    }

    function step(delta, stops) {
      const n = S.i + delta;
      if (n >= stops.length) {
        S.walk = false; S.i = 0; saveProg(id, false, 0);
        KG.toast('Прогулка завершена. Спасибо, что были с гидом!', 4500);
      } else if (n >= 0) { S.i = n; saveProg(id, true, n); }
      paint();
      if (wrap.parentNode) wrap.parentNode.scrollTop = 0;
    }

    function paint() {
      const rt = D.routeById[id];
      if (!rt || cur !== me) return;
      const stops = R.stops(rt);
      if (stops.length < 2) return;
      me.subs.forEach(function (f) { f(); });
      me.subs = [];
      S.i = Math.min(S.i, stops.length - 1);
      const legs = R.legs(stops), st = R.stats(rt);
      KG.clear(wrap);

      wrap.appendChild(el('div', { class: 'card-head' }, el('h1', { text: rt.title }),
        el('div', { class: 'pills' }, U.regionChip(rt.region), el('span', { class: 'pill', text: stopsWord(st.n) }))));
      if (S.walk) {
        const p = stops[S.i], last = S.i === stops.length - 1;
        wrap.appendChild(el('section', { class: 'card rt-walk' },
          el('div', { class: 'rt-walk-h', text: 'Следующая остановка: ' + (S.i + 1) + ' из ' + stops.length }),
          el('h2', { text: D.name(p) }),
          whereBox(p),
          playBtn(p),
          el('div', { class: 'rt-steps' },
            el('button', { class: 'btn ghost', type: 'button', disabled: S.i === 0, onclick: function () { step(-1, stops); } }, KG.icon('prev'), el('span', { text: 'Назад' })),
            el('button', { class: 'btn primary', type: 'button', onclick: function () { step(1, stops); } }, el('span', { text: last ? 'Завершить' : 'Дальше' }), KG.icon('next'))),
          el('a', { class: 'btn ghost wide', href: '#/poi/' + encodeURIComponent(p.id), text: 'Подробнее об этом месте' }),
          el('button', { class: 'btn ghost wide', type: 'button', text: 'Закончить прогулку', onclick: function () {
            S.walk = false; S.i = 0; saveProg(id, false, 0); paint();
          } })));
      }
      if (rt.intro) wrap.appendChild(el('p', { class: 'rt-intro', text: rt.intro }));
      wrap.appendChild(el('section', { class: 'card rt-est' }, KG.icon('clock'), el('span', { text: R.estimate(st) })));
      if (!S.walk) {
        wrap.appendChild(el('div', { class: 'rt-startw' }, el('button', { class: 'btn primary xl wide', type: 'button', onclick: function () {
          S.walk = true; S.i = 0; saveProg(id, true, 0); R.select(id); paint();
          if (wrap.parentNode) wrap.parentNode.scrollTop = 0;
        } }, KG.icon('route'), el('span', { text: 'Начать прогулку' }))));
      }

      wrap.appendChild(el('h2', { class: 'h-sec rt-list-h', text: 'Остановки по порядку' }));
      const list = el('div', { class: 'rt-list' });
      stops.forEach(function (p, k) {
        const done = KG.guide.isDone(p.id);
        list.appendChild(el('a', { class: 'rt-stop' + (S.walk && k === S.i ? ' cur' : ''), href: '#/poi/' + encodeURIComponent(p.id) },
          el('span', { class: 'rt-n', text: String(k + 1) }),
          el('span', { class: 'rt-main' },
            el('b', { text: D.name(p) }),
            el('span', { class: 'rt-s', text: k === 0 ? 'старт' : '≈ ' + KG.fmtDist(legs[k]) + ' от предыдущей' }),
            done ? el('span', { class: 'rt-done' }, KG.icon('check'), 'озвучено') : null),
          el('span', { class: 'rt-go', 'aria-hidden': 'true', text: '›' })));
      });
      wrap.appendChild(list);
      sub('history', function () { paint(); });

      const nv = navUrls(stops, S.walk ? S.i : 0);
      wrap.appendChild(el('div', { class: 'navs rt-navs' },
        el('a', { class: 'btn primary xl wide', href: nv.primary }, KG.icon('nav'), el('span', { text: 'Открыть маршрут в навигаторе' })),
        el('p', { class: 'rt-note', text: nv.pair
          ? 'Пеший маршрут от «' + D.name(stops[0]) + '» до «' + D.name(stops[1]) + '».'
          : 'Навигатор проведёт пешком до остановки ' + (nv.dest === stops[0] ? 1 : stops.indexOf(nv.dest) + 1) + ': «' + D.name(nv.dest) + '». Дальше — следующая остановка.' }),
        el('div', { class: 'navs-more' },
          el('a', { class: 'btn ghost', href: nv.appleWeb, target: '_blank', rel: 'noopener', text: 'Apple Maps' }),
          el('a', { class: 'btn ghost', href: nv.google, target: '_blank', rel: 'noopener', text: 'Google Карты' }))));
      wrap.appendChild(el('div', { class: 'rt-mapw' }, el('button', { class: 'btn ghost wide', type: 'button', onclick: function () { R.showOnMap(id); } }, KG.icon('map'), el('span', { text: 'Показать маршрут на карте' }))));
    }

    paint();
  };
})();
