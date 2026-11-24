/* Экран «История»: справка о городе — эпохи, роль в истории Германии, деятели, предприятия, мифы. Данные: data/history.json. */
(function () {
  'use strict';
  const KG = window.KG, el = KG.el;
  const V = (KG.views.history = {});
  let root, active = false, built = false, pending = null;
  const playBtns = new Set();

  const P = function () { return KG.card.parts; };
  const cover = function (it) { const ph = (it.photos || [])[0]; return ph ? KG.abs(ph.file) : null; };

  /* ---------- озвучка ---------- */
  function track(key, title, subtitle, it) {
    return { key: 'h:' + key, title: title, subtitle: subtitle, cover: cover(it), audio: it.audio || null, text: title + '. ' + it.story, href: '#/history/' + encodeURIComponent(key) };
  }

  function playBtn(t, label, cls) {
    const b = el('button', { class: 'btn accent hplay' + (cls ? ' ' + cls : ''), type: 'button' });
    b._paint = function () {
      const pl = KG.player, mine = pl.track && pl.track.key === t.key && pl.state !== 'idle';
      const playing = mine && (pl.state === 'playing' || pl.state === 'loading');
      KG.clear(b);
      b.appendChild(KG.icon(playing ? 'pause' : 'play'));
      b.appendChild(el('span', { text: playing ? 'Пауза' : mine ? 'Продолжить' : label }));
      b.classList.toggle('on', !!mine);
    };
    b.addEventListener('click', function () {
      const pl = KG.player;
      pl.unlock();
      if (pl.track && pl.track.key === t.key && pl.state !== 'idle') pl.toggle(); else pl.play(t);
    });
    playBtns.add(b);
    b._paint();
    return b;
  }
  function repaintPlay() { playBtns.forEach(function (b) { if (b.isConnected) b._paint(); else playBtns.delete(b); }); }

  /* ---------- общие блоки ---------- */
  function acc(id, head, build, cls) {
    const item = el('div', { class: 'acc' + (cls ? ' ' + cls : ''), id: 'h-' + id });
    const body = el('div', { class: 'acc-b', hidden: true, role: 'region' });
    const btn = el('button', { class: 'acc-h', type: 'button', 'aria-expanded': 'false' }, head, el('span', { class: 'acc-chev' }, KG.icon('chevron')));
    let filled = false;
    const set = function (open) {
      if (open && !filled) { filled = true; body.appendChild(build()); }
      btn.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      item.classList.toggle('open', open);
    };
    btn.addEventListener('click', function () { set(body.hidden); });
    item._open = function () { set(true); };
    item.appendChild(btn); item.appendChild(body);
    return item;
  }

  function story(text) { return el('div', { class: 'story' }, P().paras(text)); }
  function facts(list) {
    if (!list || !list.length) return null;
    return el('div', {}, el('h3', { class: 'h3', text: 'Интересные факты' }), el('ul', { class: 'facts' }, list.map(function (f) { return el('li', { text: f }); })));
  }
  function photos(it) {
    const ph = it.photos || [];
    if (!ph.length) return null;
    return el('div', {}, P().gallery(ph),
      el('ul', { class: 'phcred' }, ph.map(function (x) {
        return el('li', {}, (x.caption ? x.caption + ' — ' : '') + 'фото: ' + (x.author || 'автор не указан') + ', ' + (x.license || '') + ' ', x.source_url ? P().link(x.source_url, 'источник') : null);
      })));
  }
  function sources(it) {
    const src = (it.sources || []).filter(Boolean);
    if (!src.length) return null;
    return el('details', { class: 'hsrc' }, el('summary', { text: 'Источники' }), el('ul', {}, src.map(function (s) { return el('li', {}, P().link(s, P().hostOf(s))); })));
  }
  function where(it) {
    const list = (it.where || []).map(function (id) { return KG.data.byId[id]; }).filter(Boolean);
    if (!list.length) return null;
    return el('div', {}, el('h3', { class: 'h3', text: 'Где в городе' }),
      el('div', { class: 'where' }, list.map(function (p) {
        return el('a', { class: 'btn ghost', href: '#/poi/' + encodeURIComponent(p.id) }, KG.icon('nearby', 'inl'), ' ' + KG.data.name(p));
      })));
  }
  function sectionHead(id, title, hint) {
    return el('h2', { class: 'h-sec2', id: 'sec-' + id }, title, hint ? el('span', { class: 'muted small', text: ' ' + hint }) : null);
  }

  /* ---------- блоки экрана ---------- */
  function hero(H) {
    const intro = H.intro;
    if (!intro) return null;
    const t = track('intro', intro.title || 'Мюнхен за две минуты', 'Мюнхен: справка', intro);
    return el('section', { class: 'card h-hero' },
      el('div', { class: 'muted small', text: 'Справка о городе' }),
      playBtn(t, 'Послушать: ' + (intro.title || 'Мюнхен за две минуты'), 'xl wide'),
      el('details', { class: 'hread' }, el('summary', { text: 'Читать текст' }), story(intro.story), facts(intro.facts)));
  }

  function navChips(H) {
    const items = [['eras', 'Как рос город', (H.eras || []).length], ['role', 'Роль в истории', H.role], ['figures', 'Деятели', (H.figures || []).length],
      ['companies', 'Предприятия', (H.companies || []).length], ['myths', 'Мифы и факты', (H.myths || []).length]].filter(function (x) { return x[2]; });
    return el('div', { class: 'chips h-nav' }, items.map(function (x) {
      return el('button', { class: 'chip', type: 'button', text: x[1], onclick: function () {
        const n = KG.$('#sec-' + x[0], root); if (n) n.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } });
    }));
  }

  function eras(H) {
    if (!(H.eras || []).length) return null;
    return el('div', {}, sectionHead('eras', 'Как рос город', 'эпохи'),
      el('div', { class: 'timeline' }, H.eras.map(function (e) {
        return acc(e.id, [el('span', { class: 'acc-years', text: e.years || '' }), el('span', { class: 'acc-t' }, el('b', { text: e.title }), e.summary ? el('span', { class: 'muted small', text: e.summary }) : null)],
          function () {
            return el('div', {}, playBtn(track(e.id, e.title, e.years || 'История города', e), 'Слушать'), story(e.story), facts(e.facts), photos(e), sources(e));
          }, 'era');
      })));
  }

  function role(H) {
    const r = H.role;
    if (!r) return null;
    const pts = (r.points || []).map(function (p) { return el('div', { class: 'point' }, el('b', { text: p.title }), p.text ? el('p', { text: p.text }) : null); });
    return el('div', {}, sectionHead('role', 'Почему Мюнхен важен'),
      el('section', { class: 'card', id: 'h-role' }, el('h2', { text: r.title || 'Роль Мюнхена в истории Германии' }),
        playBtn(track('role', r.title || 'Роль Мюнхена в истории Германии', 'Мюнхен: справка', r), 'Слушать'),
        story(r.story), pts.length ? el('div', { class: 'points' }, pts) : null, sources(r)));
  }

  function avatar(it, icon) {
    const ph = (it.photos || [])[0];
    if (!ph) return el('span', { class: 'avatar ph' }, KG.icon(icon));
    const img = el('img', { class: 'avatar', src: ph.file, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', function () { img.replaceWith(el('span', { class: 'avatar ph' }, KG.icon(icon))); });
    return img;
  }

  function people(H) {
    if (!(H.figures || []).length) return null;
    return el('div', {}, sectionHead('figures', 'Выдающиеся деятели'),
      H.figures.map(function (f) {
        return acc(f.id, [avatar(f, 'person'), el('span', { class: 'acc-t' }, el('b', { text: f.name }),
          el('span', { class: 'muted small', text: [f.years, f.role].filter(Boolean).join(' · ') }))],
        function () {
          return el('div', {}, f.name_de ? el('div', { class: 'muted de', lang: 'de', text: f.name_de }) : null,
            f.summary ? el('p', { class: 'lead', text: f.summary }) : null,
            playBtn(track(f.id, f.name, [f.years, f.role].filter(Boolean).join(' · '), f), 'Слушать'),
            story(f.story), facts(f.facts), photos(f), where(f), sources(f));
        }, 'fig');
      }));
  }

  function companies(H) {
    if (!(H.companies || []).length) return null;
    return el('div', {}, sectionHead('companies', 'Крупные предприятия'),
      H.companies.map(function (c) {
        return acc(c.id, [avatar(c, 'building'), el('span', { class: 'acc-t' }, el('b', { text: c.name }),
          el('span', { class: 'muted small', text: [c.founded ? 'основано ' + c.founded : '', c.summary].filter(Boolean).join(' · ') }))],
        function () {
          return el('div', {}, c.name_de && c.name_de !== c.name ? el('div', { class: 'muted de', lang: 'de', text: c.name_de }) : null,
            c.summary ? el('p', { class: 'lead', text: c.summary }) : null,
            playBtn(track(c.id, c.name, c.founded ? 'основано ' + c.founded : 'Предприятия Мюнхена', c), 'Слушать'),
            story(c.story), facts(c.facts), photos(c), where(c), sources(c));
        }, 'co');
      }));
  }

  function myths(H) {
    if (!(H.myths || []).length) return null;
    return el('div', {}, sectionHead('myths', 'Мифы и факты'),
      H.myths.map(function (m, i) {
        return acc('myth-' + (i + 1), [el('span', { class: 'acc-q' }, KG.icon('help')), el('span', { class: 'acc-t' }, el('b', { text: m.q }))],
          function () { return el('div', { class: 'story' }, P().paras(m.a)); }, 'myth');
      }));
  }

  function waiting() {
    const info = el('div', { class: 'muted small' });
    const btn = el('button', { class: 'btn primary wide', type: 'button' }, KG.icon('refresh'), el('span', { text: 'Проверить обновление' }));
    btn.addEventListener('click', async function () {
      btn.disabled = true; info.textContent = 'Проверяем…';
      try { await KG.checkUpdate(info); } catch (e) { info.textContent = 'Не удалось проверить: ' + (navigator.onLine ? e.message : 'нет сети'); }
      btn.disabled = false;
    });
    return el('section', { class: 'card h-wait' }, KG.icon('history', 'big'),
      el('h2', { text: 'Раздел «История» готовится' }),
      el('p', { class: 'muted', text: 'Здесь будет справка о Мюнхене: как рос город, его роль в истории Германии, выдающиеся люди, крупные предприятия и разбор мифов. Раздел появится после обновления данных.' }),
      btn, info);
  }

  /* ---------- экран ---------- */
  function build() {
    const top = root.scrollTop, H = KG.data.history;
    KG.clear(root);
    root.appendChild(el('h1', { class: 'h-page', text: 'Мюнхен: справка' }));
    if (!H) root.appendChild(waiting());
    else [hero(H), navChips(H), eras(H), role(H), people(H), companies(H), myths(H)].forEach(function (n) { if (n) root.appendChild(n); });
    built = true;
    root.scrollTop = top;
  }

  function applyFocus() {
    const id = pending;
    if (!id) return;
    pending = null;
    const node = KG.$('[id="h-' + id + '"]', root) || KG.$('[id="sec-' + id + '"]', root);
    if (!node) return;
    if (node._open) node._open();
    requestAnimationFrame(function () { node.scrollIntoView({ block: 'start' }); });
  }

  V.init = function (r) {
    root = r;
    KG.on('data', function () { if (active) build(); else built = false; });
    KG.on('player', repaintPlay);
    KG.on('track', repaintPlay);
  };
  V.show = function () { active = true; if (!built) build(); applyFocus(); };
  V.hide = function () { active = false; };
  V.focus = function (id) { pending = id || null; if (active && built) applyFocus(); };
})();
