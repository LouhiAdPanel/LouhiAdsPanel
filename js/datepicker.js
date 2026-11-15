/* ============================================================
   LOUHI ADS — suomenkielinen päivämäärävalitsin

   Selaimen oma päivämääräkenttä (<input type="date">) näyttää kalenterin selaimen
   kielellä (esim. englanniksi), eikä sitä voi vaihtaa sivun koodista. Siksi jokainen
   päivämääräkenttä korvataan näkyvästi omalla kentällä:
   - tekstikenttä muodossa p.k.vvvv (päivän voi myös kirjoittaa, esim. 15.11.2026)
   - kalenteripainike, joka avaa suomenkielisen kalenterin: kuukaudet suomeksi,
     viikko alkaa maanantaista (Ma–Su), painikkeet Tänään ja Tyhjennä.

   Alkuperäinen <input type="date"> jää lomakkeeseen piilotettuna, ja sen arvo on
   edelleen muodossa vvvv-kk-pp. Siksi muu koodi (lomakkeiden luku, tarkistukset,
   raportoinnin ajanjaksot) toimii ennallaan: valitsin päivittää piilokentän ja lähettää
   siitä input- ja change-tapahtumat, ja kun koodi asettaa piilokentän arvon
   (esim. raportoinnin "Edellinen kuukausi"), näkyvä kenttä päivittyy.
   Virheellinen kirjoitettu päivä merkitään piilokenttään (setCustomValidity), jolloin
   lomakkeen tarkistus näyttää viestin kentän alla.

   Myöhemmin sivulle tulevat kentät (lomakeikkunat, UI.openForm) käsitellään
   automaattisesti (MutationObserver). Ei riippuvuuksia. Tyylit: style.css, osa 21.
   ============================================================ */
(() => {
  const MONTHS = ['Tammikuu', 'Helmikuu', 'Maaliskuu', 'Huhtikuu', 'Toukokuu', 'Kesäkuu',
    'Heinäkuu', 'Elokuu', 'Syyskuu', 'Lokakuu', 'Marraskuu', 'Joulukuu'];
  const DAYS = ['Ma', 'Ti', 'Ke', 'To', 'Pe', 'La', 'Su'];
  const BAD_DATE = 'Anna päivämäärä muodossa p.k.vvvv, esim. 15.11.2026.';
  const ICON = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12.5" rx="1.5"/><path d="M3 8.5h14M7 2.5v4M13 2.5v4"/></svg>';
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  const pad = (n) => String(n).padStart(2, '0');
  const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromIso = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const fiText = (iso) => { const d = fromIso(iso); return d ? `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}` : ''; };

  /** Kirjoitettu päivä -> vvvv-kk-pp. Hyväksyy p.k.vvvv, p.k.vv ja vvvv-kk-pp. null = virheellinen. */
  const parse = (text) => {
    const t = text.trim();
    let y; let mo; let d;
    let m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(t);
    if (m) { d = +m[1]; mo = +m[2]; y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; }
    else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else return null;
    const date = new Date(y, mo - 1, d);
    return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? toIso(date) : null;
  };

  let openPicker = null; // auki oleva kalenteri (vain yksi kerrallaan)

  const enhance = (native) => {
    if (native.dataset.datepicker) return;
    native.dataset.datepicker = '1';

    const wrap = document.createElement('span');
    wrap.className = 'datepicker';
    native.parentNode.insertBefore(wrap, native);
    const text = document.createElement('input');
    text.type = 'text';
    text.className = native.className;
    text.placeholder = 'pp.kk.vvvv';
    text.autocomplete = 'off';
    text.setAttribute('inputmode', 'numeric');
    const label = native.id && document.querySelector(`label[for="${native.id}"]`);
    const name = native.getAttribute('aria-label') || native.title || (label ? label.firstChild.textContent.trim() : 'Päivämäärä');
    text.setAttribute('aria-label', `${name} (pp.kk.vvvv)`);
    if (native.title) text.title = native.title;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'datepicker-btn';
    btn.innerHTML = ICON;
    btn.setAttribute('aria-label', `Avaa kalenteri: ${name}`);
    btn.setAttribute('aria-haspopup', 'dialog');
    wrap.append(text, btn, native);
    native.classList.add('datepicker-native');
    native.tabIndex = -1;
    native.setAttribute('aria-hidden', 'true');

    const sync = () => { text.value = fiText(valueDesc.get.call(native)); native.setCustomValidity(''); };
    // Koodin asettama arvo (native.value = ...) päivittää myös näkyvän kentän
    Object.defineProperty(native, 'value', {
      configurable: true,
      get() { return valueDesc.get.call(this); },
      set(v) { valueDesc.set.call(this, v); sync(); },
    });
    // Tila (disabled, readonly) ja korostusluokat (esim. is-invalid) näkyvään kenttään
    const mirror = () => {
      text.disabled = native.disabled; btn.disabled = native.disabled || native.readOnly;
      text.readOnly = native.readOnly;
      text.className = [...native.classList].filter((c) => c !== 'datepicker-native').join(' ');
    };
    new MutationObserver(mirror).observe(native, { attributes: true, attributeFilter: ['disabled', 'readonly', 'class'] });
    mirror();
    sync();

    const emit = () => {
      native.dispatchEvent(new Event('input', { bubbles: true }));
      native.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const setIso = (iso) => {
      if (valueDesc.get.call(native) === iso) { sync(); return; }
      valueDesc.set.call(native, iso);
      sync();
      emit();
    };
    // Kirjoitettu päivä tulkitaan, kun kentästä poistutaan tai painetaan Enter
    const commitText = () => {
      const t = text.value.trim();
      if (!t) { setIso(''); return; }
      const iso = parse(t);
      if (iso) { setIso(iso); return; }
      valueDesc.set.call(native, '');
      native.setCustomValidity(BAD_DATE);
      emit();
    };
    text.addEventListener('change', commitText);
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitText(); }
      if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); open(); }
    });
    if (label) label.addEventListener('click', (e) => { e.preventDefault(); text.focus(); });

    /* ---------- Kalenteri ---------- */
    let view; // näytettävän kuukauden 1. päivä
    let pop = null;

    const close = (focusText) => {
      if (!pop) return;
      pop.remove(); pop = null; openPicker = null;
      document.removeEventListener('mousedown', outside, true);
      window.removeEventListener('resize', closeNow);
      document.removeEventListener('scroll', onScroll, true);
      btn.setAttribute('aria-expanded', 'false');
      if (focusText) text.focus();
    };
    const closeNow = () => close(false);
    const outside = (e) => { if (pop && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(false); };
    const onScroll = (e) => { if (pop && !pop.contains(e.target)) close(false); };

    const render = (focusIso) => {
      const selected = valueDesc.get.call(native);
      const today = toIso(new Date());
      const first = new Date(view.getFullYear(), view.getMonth(), 1);
      const start = new Date(first);
      start.setDate(1 - ((first.getDay() + 6) % 7)); // maanantai ennen kuun alkua
      let cells = '';
      for (let i = 0; i < 42; i += 1) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        const iso = toIso(d);
        const cls = ['dp-day', d.getMonth() !== view.getMonth() ? 'is-other' : '',
          iso === today ? 'is-today' : '', iso === selected ? 'is-selected' : ''].filter(Boolean).join(' ');
        cells += `<button type="button" class="${cls}" data-iso="${iso}" tabindex="-1"
          aria-label="${d.getDate()}. ${MONTHS[d.getMonth()].toLowerCase()}ta ${d.getFullYear()}"
          ${iso === selected ? 'aria-pressed="true"' : ''}>${d.getDate()}</button>`;
      }
      pop.innerHTML = `
        <div class="dp-head">
          <button type="button" class="dp-nav" data-nav="-1" aria-label="Edellinen kuukausi">‹</button>
          <span class="dp-title" aria-live="polite">${MONTHS[view.getMonth()]} ${view.getFullYear()}</span>
          <button type="button" class="dp-nav" data-nav="1" aria-label="Seuraava kuukausi">›</button>
        </div>
        <div class="dp-grid" role="grid">
          ${DAYS.map((d) => `<span class="dp-wd" aria-hidden="true">${d}</span>`).join('')}
          ${cells}
        </div>
        <div class="dp-foot">
          <button type="button" class="dp-link" data-act="today">Tänään</button>
          <button type="button" class="dp-link" data-act="clear">Tyhjennä</button>
        </div>`;
      // Fokus valittuun, tähän päivään tai kuun ensimmäiseen (nuolinäppäimet liikkuvat)
      const want = focusIso || (selected && fromIso(selected).getMonth() === view.getMonth() ? selected : null)
        || (fromIso(today).getMonth() === view.getMonth() && fromIso(today).getFullYear() === view.getFullYear() ? today : toIso(first));
      const target = pop.querySelector(`[data-iso="${want}"]`);
      if (target) { target.tabIndex = 0; target.focus(); }
    };

    const position = () => {
      const r = text.getBoundingClientRect();
      const h = pop.offsetHeight; const w = pop.offsetWidth;
      const below = r.bottom + 4 + h <= window.innerHeight;
      pop.style.top = `${Math.max(4, below ? r.bottom + 4 : r.top - h - 4)}px`;
      pop.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 4))}px`;
    };

    function open() {
      if (text.disabled || text.readOnly) return;
      if (openPicker) openPicker(false);
      const cur = fromIso(valueDesc.get.call(native)) || parse(text.value) && fromIso(parse(text.value)) || new Date();
      view = new Date(cur.getFullYear(), cur.getMonth(), 1);
      pop = document.createElement('div');
      pop.className = 'datepicker-pop';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', `Kalenteri: ${name}`);
      // Avoimen lomakeikkunan sisään, jotta kalenteri näkyy ikkunan päällä
      (text.closest('dialog') || document.body).appendChild(pop);
      render();
      position();
      openPicker = close;
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', outside, true);
      window.addEventListener('resize', closeNow);
      document.addEventListener('scroll', onScroll, true);

      pop.addEventListener('click', (e) => {
        const day = e.target.closest('[data-iso]');
        const nav = e.target.closest('[data-nav]');
        const act = e.target.closest('[data-act]');
        if (day) { setIso(day.dataset.iso); close(true); }
        else if (nav) { view.setMonth(view.getMonth() + Number(nav.dataset.nav)); render(); nav.blur(); pop.querySelector(`[data-nav="${nav.dataset.nav}"]`).focus(); }
        else if (act) { setIso(act.dataset.act === 'today' ? toIso(new Date()) : ''); close(true); }
      });
      pop.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          // Esc sulkee vain kalenterin, ei lomakeikkunaa
          e.preventDefault(); e.stopPropagation(); close(true); return;
        }
        if (e.key === 'Tab') {
          // Fokus kiertää kalenterin sisällä
          const items = [...pop.querySelectorAll('.dp-nav, .dp-day[tabindex="0"], .dp-link')];
          const i = items.indexOf(document.activeElement);
          e.preventDefault();
          items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
          return;
        }
        const day = e.target.closest('[data-iso]');
        if (!day) return;
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
        if (step || e.key === 'PageUp' || e.key === 'PageDown') {
          e.preventDefault();
          const d = fromIso(day.dataset.iso);
          if (step) d.setDate(d.getDate() + step);
          else d.setMonth(d.getMonth() + (e.key === 'PageUp' ? -1 : 1));
          if (d.getMonth() !== view.getMonth() || d.getFullYear() !== view.getFullYear()) {
            view = new Date(d.getFullYear(), d.getMonth(), 1);
          }
          render(toIso(d));
        }
      });
    }

    btn.addEventListener('click', () => (pop ? close(true) : open()));
  };

  const scan = (root) => {
    if (root.matches && root.matches('input[type="date"]')) enhance(root);
    if (root.querySelectorAll) root.querySelectorAll('input[type="date"]').forEach(enhance);
  };
  scan(document);
  new MutationObserver((records) => {
    records.forEach((r) => r.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); }));
  }).observe(document.body, { childList: true, subtree: true });
})();
