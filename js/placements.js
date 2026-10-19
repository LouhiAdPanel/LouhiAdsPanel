/* Mainospaikat-sivu (placements.html): listaus, luonti, muokkaus, poisto ja upotuskoodi.
   Toteutettu wireframejen "Mainospaikat / Uusi mainospaikka / Muokkaa mainospaikkaa" mukaan.

   Käyttäjä voi:
   - selata mainospaikkoja ja avata paikan upotuskoodin (kaikki käyttäjät)
   - luoda, muokata ja poistaa mainospaikkoja (VAIN ADMIN; painikkeissa .admin-only,
     palvelin tarkistaa oikeuden require_admin-riippuvuudella). Poisto kysyy vahvistuksen.

   API:
   - GET    /api/placements        lista
   - POST   /api/placements        uusi paikka; Koodi-kenttä ehdotetaan nimestä, tyhjänä
                                   palvelin muodostaa sen itse. Nimen on oltava yksilöllinen
                                   (409); hyvin samankaltaisesta nimestä varoitetaan.
   - PUT    /api/placements/{id}   päivitys (koodi ei muutu)
   - DELETE /api/placements/{id}   poisto

   Koodi (placement ID) on tunniste, jolla sivustoille upotettu mainostagi pyytää mainoksia
   (<div data-placement="...">). Siksi sitä ei voi muuttaa luonnin jälkeen. */
(() => {
  const tbody = document.getElementById('placements-body');
  const countEl = document.getElementById('placements-count');
  const COLS = 5;
  let placements = [];

  // Lomakkeen ympäristövaihtoehdot (Louhen palvelut, joihin mainospaikkoja sijoitetaan).
  // Tietokannassa environment on vapaa teksti, joten listaa voi laajentaa tästä.
  const ENVIRONMENTS = ['Louhi Konsoli', 'www', 'Domain Control Panel', 'Tukiportaali', 'cPanel'];

  // width/height ovat mainospaikan koko: mainostagi skaalaa kuvan tähän kokoon.
  // Kentät wireframen järjestyksessä (Nimi, Koodi, Leveys, Korkeus, Status).
  // Ympäristö on lisäksi pakollinen tieto (sprintin hyväksymiskriteeri, tietokannan sarake).
  // Funktio: Koodi on muokattaessa vain luku.
  const fields = (isNew) => [
    { name: 'name', label: 'Nimi', required: true, maxlength: 150, placeholder: 'Louhi Konsoli – pääbanneri', wide: true,
      help: 'Nimen on oltava yksilöllinen.' },
    { name: 'code', label: 'Koodi', required: isNew, maxlength: 64, pattern: '[a-z0-9_]{2,64}', wide: true,
      readonly: !isNew, placeholder: 'louhi_konsoli_paabanneri',
      help: isNew
        ? 'Ehdotetaan nimestä. Vain pienet kirjaimet a–z, numerot ja _. Käytetään upotuskoodissa.'
        : 'Koodia ei voi muuttaa, koska se on upotettu sivustojen koodiin.' },
    { name: 'width', label: 'Leveys (px)', type: 'number', required: true, min: 1, max: 5000 },
    { name: 'height', label: 'Korkeus (px)', type: 'number', required: true, min: 1, max: 5000 },
    { name: 'status', label: 'Status', type: 'select', required: true,
      options: [{ value: 'active', label: 'Aktiivinen' }, { value: 'paused', label: 'Keskeytetty' },
        { value: 'inactive', label: 'Ei aktiivinen' }] },
    { name: 'environment', label: 'Ympäristö', type: 'select', required: true,
      options: ENVIRONMENTS.map((e) => ({ value: e, label: e })) },
  ];

  /**
   * Sama sääntö kuin palvelimella (backend/app/slug.py) – käytetään vain esikatseluun.
   * Vaiheet: ääkköset perusmuotoon (ä -> a), pienet kirjaimet, muut merkit alaviivoiksi,
   * reunojen alaviivat pois, etuliite louhi_ ja enintään 60 merkkiä.
   * Lopullisen tunnuksen päättää aina palvelin (esim. lisää _2, jos tunnus on varattu).
   * Esim. 'Louhi Konsoli – pääbanneri' -> 'louhi_konsoli_paabanneri'.
   */
  const previewCode = (name) => {
    let slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!slug) slug = 'mainospaikka';
    if (!slug.startsWith('louhi')) slug = `louhi_${slug}`;
    return slug.slice(0, 60).replace(/_+$/, '');
  };

  /* ---------- Nimen yksilöllisyys ----------
     Kaksi samannimistä mainospaikkaa on helppo sekoittaa (esim. mainosta sijoitettaessa).
     - Sama nimi (kirjainkoosta ja välilyönneistä riippumatta, "Demo hero" = "demo  HERO")
       estetään. Palvelin tekee saman tarkistuksen (placements.py, 409).
     - Hyvin samankaltaisesta nimestä (esim. "Demo-hero", "Demo heroo") varoitetaan, ja
       tallennus kysyy vahvistuksen. */

  /** Vertailuavain samalle nimelle: välilyönnit siistitty, pienet kirjaimet. */
  const nameKey = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  /** Väljempi avain: vain kirjaimet ja numerot ("Demo-hero" = "demo hero" = "DemoHero"). */
  const looseKey = (name) => nameKey(name).replace(/[^\p{L}\p{N}]/gu, '');

  /** Levenshtein-etäisyys: montako merkkiä pitää lisätä, poistaa tai vaihtaa. */
  const editDistance = (a, b) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
      const cur = [i];
      for (let j = 1; j <= b.length; j += 1) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  };

  /**
   * Vertaa nimeä muihin mainospaikkoihin (muokattava paikka ohitetaan).
   * Palauttaa { same: paikka | undefined, similar: paikka | undefined }.
   * Samankaltainen = samat kirjaimet ja numerot, tai 1–2 merkin ero
   * (lyhyillä, alle 10 merkin nimillä enintään 1).
   */
  const checkName = (name, selfId) => {
    const others = placements.filter((p) => p.id !== selfId);
    const key = nameKey(name);
    const loose = looseKey(name);
    if (!loose) return {};
    const same = others.find((p) => nameKey(p.name) === key);
    if (same) return { same };
    const limit = loose.length < 10 ? 1 : 2;
    const similar = others.find((p) => {
      const other = looseKey(p.name);
      return other === loose || (Math.abs(other.length - loose.length) <= limit
        && editDistance(other, loose) <= limit);
    });
    return { similar };
  };

  /**
   * Näyttää nimen tarkistuksen tuloksen Nimi-kentän alla kirjoittamisen aikana.
   * UI.openForm kutsuu tätä (onRender) sekä uudella että muokattavalla paikalla.
   */
  const attachNameCheck = (form, selfId) => {
    const name = form.elements.name;
    const help = name.closest('.field').querySelector('.field-help');
    const defaultHelp = help.textContent;
    const update = () => {
      const { same, similar } = checkName(name.value, selfId);
      help.textContent = same ? `Mainospaikka nimellä "${same.name}" on jo olemassa – anna eri nimi.`
        : similar ? `Huom: hyvin samankaltainen nimi on jo olemassa: "${similar.name}".`
          : defaultHelp;
      help.classList.toggle('cell-warn', Boolean(same || similar));
      name.setCustomValidity(same ? 'Samanniminen mainospaikka on jo olemassa.' : '');
    };
    name.addEventListener('input', update);
    update();
  };

  /**
   * Uudella mainospaikalla Koodi-kenttään ehdotetaan koodia nimestä niin kauan, kunnes
   * käyttäjä muokkaa koodia itse. Varattu koodi näytetään varoituksena kentän alla.
   * UI.openForm kutsuu tätä (onRender), kun lomake on piirretty.
   */
  const attachCodeSuggestion = (form) => {
    const code = form.elements.code;
    const help = code.closest('.field').querySelector('.field-help');
    const defaultHelp = help.textContent;
    let edited = false;
    const check = () => {
      const taken = placements.some((p) => p.code === code.value);
      help.textContent = taken ? 'Koodi on jo käytössä – valitse toinen.' : defaultHelp;
      help.classList.toggle('cell-warn', taken);
    };
    form.elements.name.addEventListener('input', () => {
      if (edited) return;
      const name = form.elements.name.value.trim();
      code.value = name ? previewCode(name) : '';
      check();
    });
    code.addEventListener('input', () => { edited = true; check(); });
  };

  /** Piirtää mainospaikkataulukon. Muokkaa-painike näkyy vain adminille (.admin-only). */
  const render = () => {
    countEl.textContent = `Kaikki mainospaikat (${placements.length})`;
    if (!placements.length) {
      UI.tableMessage(tbody, COLS, 'Ei vielä mainospaikkoja. Luo ensimmäinen yläkulman painikkeesta.');
      return;
    }
    // Wireframen sarakkeet: nimi, koodi, koko, status, toiminnot. Ympäristö näytetään nimen
    // alla ja upotuskoodin linkki koodin alla.
    tbody.innerHTML = placements.map((p) => `
      <tr>
        <td>${UI.esc(p.name)}<span class="cell-sub">${UI.esc(p.environment)}</span></td>
        <td class="cell-mono">${UI.esc(p.code)}
          <button class="btn-ghost cell-sub" data-embed="${p.id}">Upotuskoodi</button></td>
        <td class="cell-muted">${p.width} × ${p.height}</td>
        <td>${UI.pill(p.status)}</td>
        <td class="cell-actions">
          <button class="btn btn-small admin-only" data-edit="${p.id}">Muokkaa</button>
          <button class="btn btn-small btn-small-danger admin-only" data-delete="${p.id}">Poista</button>
        </td>
      </tr>`).join('');
  };

  /** Hakee mainospaikat palvelimelta ja piirtää taulukon. */
  const load = async () => {
    UI.tableMessage(tbody, COLS, 'Ladataan…');
    try {
      placements = await Api.get('/api/placements');
      render();
    } catch (err) {
      UI.tableMessage(tbody, COLS, err.message, true);
    }
  };

  /**
   * Avaa "Uusi mainospaikka"- tai "Muokkaa mainospaikkaa" -lomakkeen (vain admin).
   * placement = null -> uusi mainospaikka.
   */
  const openEditor = (placement) => {
    const isNew = !placement;
    const f = fields(isNew);
    const envField = f.find((x) => x.name === 'environment');
    if (placement && !ENVIRONMENTS.includes(placement.environment)) {
      envField.options = [...envField.options, { value: placement.environment, label: placement.environment }];
    }
    UI.openForm({
      title: isNew ? 'Uusi mainospaikka' : 'Muokkaa mainospaikkaa',
      fields: f,
      values: placement || { status: 'active', environment: ENVIRONMENTS[0] },
      submitLabel: isNew ? 'Hyväksy' : 'Tallenna muutokset',
      onRender: (form) => {
        attachNameCheck(form, placement ? placement.id : null);
        if (isNew) attachCodeSuggestion(form);
      },
      onSubmit: async (data) => {
        // Sama nimi on estetty jo kentän tarkistuksessa (setCustomValidity). Hyvin
        // samankaltaisesta nimestä kysytään vahvistus; muokattaessa vain, jos nimi muuttui.
        const nameChanged = isNew || nameKey(data.name) !== nameKey(placement.name);
        const { similar } = nameChanged ? checkName(data.name, placement ? placement.id : null) : {};
        if (similar) {
          const ok = await UI.confirm({
            title: 'Samankaltainen nimi',
            message: `Mainospaikka nimellä "${similar.name}" on jo olemassa. Tallennetaanko silti nimellä "${data.name.trim()}"?`,
            confirmLabel: 'Tallenna silti',
          });
          if (!ok) return false; // lomake jää auki nimen korjaamista varten
        }
        if (isNew) {
          await Api.post('/api/placements', data);
          UI.toast('Mainospaikka luotu.');
        } else {
          const { code, ...rest } = data;   // koodia ei lähetetä muokattaessa
          await Api.put(`/api/placements/${placement.id}`, rest);
          UI.toast('Muutokset tallennettu.');
        }
        load();
      },
    });
  };

  /**
   * Poista-painike: vahvistus (wireframe), sitten poisto. Poisto poistaa myös paikan
   * sijoitukset ja tilastot, joten se mainitaan kysymyksessä.
   */
  const deletePlacement = async (p) => {
    const ok = await UI.confirm({
      title: 'Poista mainospaikka',
      message: `Haluatko varmasti poistaa mainospaikan ${p.name}? Paikan mainossijoitukset ja tilastot poistuvat samalla.`,
    });
    if (!ok) return;
    try {
      await Api.del(`/api/placements/${p.id}`);
      UI.toast('Mainospaikka poistettu.');
      load();
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  };

  /**
   * Näyttää mainospaikan upotuskoodin kopioitavaksi.
   * Koodi = paikkamerkki-div (data-placement = Placement ID) + louhi-ads.js-skripti, joka
   * hakee mainoksen palvelimelta ja piirtää sen diviin. Skriptin osoite muodostetaan
   * nykyisestä originista, jotta koodi osoittaa samaan palvelimeen kuin paneeli.
   * "Testaa demosivulla" avaa ad-demo.html:n, joka näyttää paikan mainoksen oikeasti.
   */
  const showEmbed = (p) => {
    const origin = window.location.origin;
    const code =
`<div class="louhi-ad" data-placement="${p.code}"></div>
<script src="${origin}/louhi-ads.js" async></script>`;
    const dialog = UI.openInfo(`Upotuskoodi: ${p.name}`, `
      <p class="cell-muted" style="margin-bottom:12px">
        Lisää tämä koodi sivulle kohtaan, jossa mainos näytetään (${p.width} × ${p.height} px).
        Skripti tarvitsee lisätä sivulle vain kerran, vaikka mainospaikkoja olisi useita.
      </p>
      <pre class="code-block">${UI.esc(code)}</pre>
      <div class="modal-footer" style="padding:16px 0 0;background:none;border:none">
        <span class="spacer"></span>
        <a class="btn btn-secondary" href="/ad-demo.html?placement=${encodeURIComponent(p.code)}" target="_blank">Testaa demosivulla</a>
        <button class="btn btn-primary" data-copy>Kopioi</button>
      </div>`);
    // Leikepöytä-API voi epäonnistua (esim. ei HTTPS:ää tai lupa evätty) -> ohjeistetaan käsin.
    dialog.querySelector('[data-copy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
        UI.toast('Upotuskoodi kopioitu leikepöydälle.');
      } catch {
        UI.toast('Kopiointi ei onnistunut – valitse teksti ja kopioi käsin.', 'error');
      }
    });
  };

  // Event delegation: rivit piirretään uudelleen joka latauksessa, joten kuunnellaan tbodya.
  tbody.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-delete]');
    const embed = e.target.closest('[data-embed]');
    if (edit) openEditor(placements.find((p) => p.id === Number(edit.dataset.edit)));
    if (del) deletePlacement(placements.find((p) => p.id === Number(del.dataset.delete)));
    if (embed) showEmbed(placements.find((p) => p.id === Number(embed.dataset.embed)));
  });
  document.getElementById('new-placement').addEventListener('click', () => openEditor(null));

  load();
})();
