/* ============================================================
   LOUHI ADS — yhteiset käyttöliittymäapurit
   Muotoilu (luvut, päivät), tilamerkit, ilmoitukset (toast)
   ja yleiskäyttöinen lomakeikkuna (<dialog>).

   Käytetään: kaikilla kirjautumisen takana olevilla sivuilla
   (dashboard, campaigns, creatives, placements, advertisers, reporting, users).
   Riippuvuudet: ei suoria. Kuvan latauskenttä kutsuu kentän omaa
   upload-funktiota, joka sivuskripteissä on yleensä Api.upload (api.js).
   Tyylit (modal, pill, toast, image-drop) ovat style.css:ssä.

   Rakenne: kaikki on yhden IIFE-funktion sisällä, joten apufunktiot
   eivät valu globaaliin nimiavaruuteen. Ulos näkyy vain UI-olio
   (ks. return tiedoston lopussa).
   ============================================================ */

const UI = (() => {
  /* ---------- Turvallisuus: käyttäjän syöte aina escapettuna HTML:ään ----------
     Sivut rakentavat HTML:ää template-merkkijonoilla ja innerHTML:llä. Jos
     esim. kampanjan nimi sisältäisi <script>-tagin, se suoritettaisiin (XSS).
     esc() muuttaa erikoismerkit HTML-entiteeteiksi, joten teksti näkyy tekstinä.
     Sääntö: KAIKKI tietokannasta tai käyttäjältä tuleva arvo UI.esc():n läpi. */
  /** @param {*} value mikä tahansa arvo; null/undefined -> '' */
  const esc = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  /* ---------- Muotoilu (suomalainen esitystapa) ----------
     Muotoilijat luodaan kerran, koska Intl-olion luonti on suhteellisen raskas.
     Puuttuva arvo näytetään ajatusviivana '–'. */
  const numberFmt = new Intl.NumberFormat('fi-FI');
  const pctFmt = new Intl.NumberFormat('fi-FI', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /** Kokonaisluku tuhaterottimin, esim. 12345 -> '12 345'. */
  const fmtInt = (n) => (n === null || n === undefined ? '–' : numberFmt.format(n));
  /** Prosentti kahdella desimaalilla, esim. 1.5 -> '1,50 %'. n on jo prosentteina. */
  const fmtPct = (n) => (n === null || n === undefined ? '–' : `${pctFmt.format(n)} %`);

  /** ISO-aikaleima -> 'p.k.vvvv' (paikallinen aika), esim. '3.10.2026'. */
  const fmtDate = (iso) => {
    if (!iso) return '–';
    const d = new Date(iso);
    return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
  };

  /**
   * Aikaväli lyhyesti: '1.3.–31.3.2026'. Alkuvuosi jätetään pois, jos se on
   * sama kuin loppuvuosi. Jos toinen päivä puuttuu, se näytetään '–'.
   */
  const fmtRange = (start, end) => {
    if (!start && !end) return '–';
    if (!start || !end) return `${fmtDate(start)} – ${fmtDate(end)}`;
    const s = new Date(start);
    const e = new Date(end);
    const sameYear = s.getFullYear() === e.getFullYear();
    return `${s.getDate()}.${s.getMonth() + 1}.${sameYear ? '' : s.getFullYear()}–${fmtDate(end)}`;
  };

  /** ISO-aikaleima -> 'YYYY-MM-DD' (paikallinen aika) <input type="date">:lle.
      Ei toISOString().slice(0, 10), koska se antaisi UTC-päivän ja voisi heittää päivällä. */
  const isoToDateInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /** 'YYYY-MM-DD' -> ISO-aikaleima. endOfDay=true -> klo 23:59:59
      (kampanjan loppupäivä on näin voimassa koko päivän). Palauttaa null, jos tyhjä. */
  const dateInputToIso = (value, endOfDay = false) => {
    if (!value) return null;
    // Osat erikseen: new Date('2026-03-01') tulkittaisiin UTC-keskiyöksi, ei paikalliseksi
    const [y, m, d] = value.split('-').map(Number);
    const date = endOfDay ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d, 0, 0, 0);
    return date.toISOString();
  };

  /* ---------- Tilamerkit ----------
     Backendin tila-avain (esim. campaign.display_status) -> suomenkielinen
     teksti ja CSS-luokka. Uusi tila lisätään tähän ja tarvittaessa style.css:ään. */
  const STATUS = {
    active:   { label: 'Aktiivinen',        cls: 'pill-active' },
    pending:  { label: 'Odottaa alkamista', cls: 'pill-pending' },
    paused:   { label: 'Keskeytetty',       cls: 'pill-paused' },
    draft:    { label: 'Luonnos',           cls: 'pill-draft' },
    ended:    { label: 'Päättynyt',         cls: 'pill-draft' },
    archived: { label: 'Arkistoitu',        cls: 'pill-draft' },
    inactive: { label: 'Ei aktiivinen',     cls: 'pill-draft' },
    suspended: { label: 'Jäädytetty',      cls: 'pill-paused' },
  };

  /**
   * Palauttaa tilamerkin HTML:n. Tuntematon tila näytetään sellaisenaan harmaana.
   * labels (valinnainen): sivukohtaiset tekstit, esim. { paused: 'Tauolla' } mainoksille.
   */
  const pill = (status, labels = {}) => {
    const s = STATUS[status] || { label: status, cls: 'pill-draft' };
    return `<span class="pill ${s.cls}">${esc(labels[status] || s.label)}</span>`;
  };

  /* ---------- Taulukon tilat: lataus / tyhjä / virhe ---------- */
  /**
   * Korvaa taulukon rungon yhdellä koko levyisellä viestirivillä.
   * @param {HTMLElement} tbody  taulukon <tbody>
   * @param {number} cols        sarakkeiden määrä (colspan)
   * @param {string} text        viesti, esim. 'Ladataan…'
   * @param {boolean} [isError]  true -> virhetyyli
   */
  const tableMessage = (tbody, cols, text, isError = false) => {
    tbody.innerHTML = `<tr><td colspan="${cols}" class="table-message${isError ? ' is-error' : ''}">${esc(text)}</td></tr>`;
  };

  /* ---------- Ilmoitukset ---------- */
  let toastBox;
  /**
   * Näyttää lyhyen ilmoituksen oikeassa reunassa; poistuu itsestään.
   * @param {string} message
   * @param {'success'|'error'} [type]  virheet näkyvät pidempään (6 s vs. 3,5 s)
   */
  const toast = (message, type = 'success') => {
    // Säiliö luodaan vasta ensimmäisellä kutsulla. role=status + aria-live
    // saa ruudunlukijan lukemaan ilmoituksen keskeyttämättä käyttäjää.
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'toast-container';
      toastBox.setAttribute('role', 'status');
      toastBox.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastBox);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message; // textContent eikä innerHTML -> ei XSS-riskiä
    toastBox.appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
  };

  /* ---------- Yleiskäyttöinen lomakeikkuna ----------
     openForm({
       title, submitLabel,
       fields: [{ name, label, type, required, options, help, ... }],
       values: { ... },               // muokattaessa nykyiset arvot
       onSubmit: async (data) => {},  // heittää virheen -> näytetään ikkunassa
       onDelete: async () => {},      // valinnainen: näyttää Poista-painikkeen
       onRender: (form) => {},        // valinnainen: lisälogiikka (esim. esikatselu)
     })
     Kenttätyypit: text, url, number, date, password, select, checkboxes,
     multiselect (pudotusvalikko, jossa valintaruudut), textarea ja image
     (kuvan lataus tai URL, ks. attachImageField).
     Muita kentän asetuksia: placeholder, pattern, min, max, maxlength,
     readonly, wide (koko levyinen), numeric (muunna luvuksi), emptyValue
     (arvo tyhjälle kentälle, oletus null), accept/upload/onUploaded (image),
     tooltip (?-ohje otsikon perässä), validate (kentän oma tarkistus), patternMessage.
     Lomakkeen muut asetukset: deleteLabel, deleteConfirm (vahvistuskysymys),
     deleteConfirmLabel (vahvistuspainikkeen teksti, esim. 'Kyllä'),
     busyLabel (painikkeen teksti käsittelyn aikana), validate (lomakkeen yhteiset
     tarkistussäännöt, ks. "Lomakkeen tarkistus" alla). Jos onSubmit palauttaa false,
     ikkuna jää auki ilman virheilmoitusta (esim. "Palaa takaisin muokkaamaan").
  */

  /**
   * Palauttaa yhden lomakekentän HTML:n.
   * @param {object} f  kentän määrittely (ks. yllä)
   * @param {*} value   nykyinen arvo (muokkaustilassa) tai undefined
   * @returns {string} HTML-merkkijono; kaikki tekstit escapetaan esc():llä
   */
  /** ?-ohje kentän otsikon perään. Teksti näytetään hiiren alla ja näppäimistöfokuksessa (ks. tooltipit alla). */
  const tip = (text) => text
    ? ` <span class="help-tip" tabindex="0" role="note" aria-label="Ohje: ${esc(text)}" data-tip="${esc(text)}">?</span>`
    : '';

  const renderField = (f, value) => {
    // id yhdistää <label for> ja kentän: klikkaus otsikkoon fokusoi kentän
    const id = `f-${f.name}`;
    const req = f.required ? 'required' : '';
    // Valinnaiset HTML-attribuutit; puuttuvat jäävät tyhjiksi merkkijonoiksi.
    // readonly-kenttä poistetaan sarkainjärjestyksestä (tabindex -1).
    // Salasanakentän autocomplete ohjaa selaimen salasanamanageria.
    const attrs = [
      f.placeholder ? `placeholder="${esc(f.placeholder)}"` : '',
      f.pattern ? `pattern="${esc(f.pattern)}"` : '',
      f.min !== undefined ? `min="${f.min}"` : '',
      f.max !== undefined ? `max="${f.max}"` : '',
      f.maxlength ? `maxlength="${f.maxlength}"` : '',
      f.readonly ? 'readonly tabindex="-1"' : '',
      f.type === 'password' ? `autocomplete="${f.autocomplete || 'new-password'}"` : '',
    ].join(' ');
    const help = f.help ? `<small class="field-help">${esc(f.help)}</small>` : '';
    const label = `<label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}${tip(f.tooltip)}</label>`;
    const wide = f.wide ? ' field-wide' : '';

    if (f.type === 'select') {
      // Vertailu merkkijonoina: arvo voi olla luku (id), mutta <option value> on aina teksti
      const opts = (f.options || [])
        .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`)
        .join('');
      return `<div class="field${wide}" data-field="${f.name}">${label}<select id="${id}" name="${f.name}" class="select" ${req}>${opts}</select>${help}</div>`;
    }

    // Monivalinta (esim. kampanjan mainospaikat). value = taulukko valittuja arvoja.
    if (f.type === 'checkboxes' || f.type === 'multiselect') {
      const selected = new Set((value || []).map(String));
      const boxes = (f.options || [])
        .map((o) => `<label class="check"><input type="checkbox" name="${f.name}" value="${esc(o.value)}" ${selected.has(String(o.value)) ? 'checked' : ''}> ${esc(o.label)}</label>`)
        .join('');
      // Monivalinta pudotusvalikkona: <details> avautuu ja sulkeutuu ilman JavaScriptiä;
      // yhteenveto (valitut) päivitetään attachMultiselect-funktiossa.
      if (f.type === 'multiselect') {
        return `<fieldset class="field field-wide" data-field="${f.name}"><legend>${esc(f.label)}${f.required ? ' *' : ''}${tip(f.tooltip)}</legend>
          <details class="multiselect" data-multiselect="${f.name}">
            <summary class="select">${esc(f.placeholder || 'Valitse')}</summary>
            <div class="check-group">${boxes || '<span class="cell-muted">Ei vaihtoehtoja</span>'}</div>
          </details>${help}</fieldset>`;
      }
      return `<fieldset class="field field-wide" data-field="${f.name}"><legend>${esc(f.label)}${f.required ? ' *' : ''}${tip(f.tooltip)}</legend><div class="check-group">${boxes || '<span class="cell-muted">Ei vaihtoehtoja</span>'}</div>${help}</fieldset>`;
    }

    // Kuvakenttä: varsinainen arvo (ladatun kuvan URL) on piilokentässä, jonka
    // attachImageField täyttää latauksen jälkeen. Tiedostokenttä on piilossa
    // <label class="btn"> sisällä, jotta painike voidaan tyylitellä vapaasti.
    if (f.type === 'image') {
      const preview = value
        ? `<img src="${esc(value)}" alt="">`
        : '<span>Ei kuvaa</span>';
      return `
        <div class="field field-wide image-field" data-field="${f.name}" data-image-field="${f.name}">
          <span class="field-label">${esc(f.label)}${f.required ? ' *' : ''}</span>
          <input type="hidden" name="${f.name}" value="${esc(value ?? '')}">
          <div class="image-drop" tabindex="-1">
            <div class="image-drop-preview">${preview}</div>
            <div class="image-drop-body">
              <label class="btn btn-secondary">
                ${value ? 'Vaihda kuva' : 'Valitse kuva'}
                <input type="file" accept="${esc(f.accept || 'image/png,image/jpeg')}" hidden>
              </label>
              <span class="field-help">tai raahaa kuva tähän, tai liitä kuvan osoite:</span>
              <input type="url" class="input image-url-input" placeholder="https://…/kuva.png"
                     value="${value && /^https?:/.test(value) ? esc(value) : ''}" aria-label="Mainoskuvan URL">
              ${help}
              <span class="upload-status" aria-live="polite"></span>
            </div>
          </div>
        </div>`;
    }

    if (f.type === 'textarea') {
      return `<div class="field field-wide" data-field="${f.name}">${label}<textarea id="${id}" name="${f.name}" class="input" rows="3" ${req} ${attrs}>${esc(value ?? '')}</textarea>${help}</div>`;
    }

    return `<div class="field${wide}" data-field="${f.name}">${label}<input id="${id}" name="${f.name}" type="${f.type || 'text'}" class="input" value="${esc(value ?? '')}" ${req} ${attrs}>${help}</div>`;
  };

  /**
   * Lukee lomakkeen arvot olioksi { kentän nimi: arvo }, joka lähetetään backendille.
   * Tekstit trimmataan (paitsi salasana), tyhjä -> null (tai f.emptyValue),
   * number/numeric -> Number. Checkboxes -> taulukko (oletuksena lukuina, koska id:itä).
   */
  const readForm = (form, fields) => {
    const data = {};
    fields.forEach((f) => {
      if (f.type === 'checkboxes' || f.type === 'multiselect') {
        data[f.name] = [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map((i) =>
          f.numeric === false ? i.value : Number(i.value));
        return;
      }
      const value = form.elements[f.name].value;
      const raw = f.type === 'password' ? value : value.trim();
      if (raw === '') data[f.name] = f.emptyValue !== undefined ? f.emptyValue : null;
      else if (f.type === 'number' || f.numeric) data[f.name] = Number(raw);
      else data[f.name] = raw;
    });
    return data;
  };

  // Sama raja tarkistetaan myös backendissä; tässä vain nopeampi palaute käyttäjälle.
  const MAX_IMAGE_MB = 5;

  /**
   * Kytkee kuvakentän toiminnot: tiedoston valinta ja drag & drop, tyypin ja koon
   * tarkistus, lataus palvelimelle f.upload(file)-funktiolla sekä esikatselu.
   * Kuva ladataan heti valittaessa, ja lomakkeelle tallentuu vain kuvan URL.
   * @param {HTMLFormElement} form
   * @param {object} f  kuvakentän määrittely: upload (pakollinen), accept, onUploaded
   */
  const attachImageField = (form, f) => {
    const box = form.querySelector(`[data-image-field="${f.name}"]`);
    const hidden = box.querySelector(`input[name="${f.name}"]`);
    const fileInput = box.querySelector('input[type="file"]');
    const preview = box.querySelector('.image-drop-preview');
    const status = box.querySelector('.upload-status');
    const drop = box.querySelector('.image-drop');
    const allowed = (f.accept || 'image/png,image/jpeg').split(',');

    /** Käsittelee yhden tiedoston (valittu tai pudotettu). */
    const handle = async (file) => {
      if (!file) return;
      status.classList.remove('is-error');
      if (!allowed.includes(file.type)) {
        status.textContent = 'Vain JPG- ja PNG-kuvat ovat sallittuja.';
        status.classList.add('is-error');
        return;
      }
      if (file.size > MAX_IMAGE_MB * 1024 * 1024) {
        status.textContent = `Kuva on liian suuri (enintään ${MAX_IMAGE_MB} Mt).`;
        status.classList.add('is-error');
        return;
      }
      // Merkki lomakkeelle: tallennus estetään, kunnes lataus on valmis (ks. submit)
      form.dataset.uploading = '1';
      status.textContent = 'Ladataan kuvaa…';
      try {
        const result = await f.upload(file);
        hidden.value = result.image_url;
        hidden.dispatchEvent(new Event('change', { bubbles: true })); // poistaa mahdollisen virheviestin
        urlInput.value = '';
        preview.innerHTML = `<img src="${esc(result.image_url)}" alt="">`;
        status.textContent = `${file.name} · ${result.width} × ${result.height} px`;
        // firstChild = painikkeen tekstisolmu; muutetaan vain sitä, jotta sisällä
        // oleva <input type="file"> säilyy
        box.querySelector('label.btn').firstChild.textContent = 'Vaihda kuva ';
        const formError = form.querySelector('.form-error');
        if (formError) formError.hidden = true;   // aiempi "lataa kuva" -virhe pois
        if (f.onUploaded) f.onUploaded(result, form);
      } catch (err) {
        status.textContent = err.message;
        status.classList.add('is-error');
      } finally {
        delete form.dataset.uploading;
        // Tyhjennys sallii saman tiedoston valitsemisen uudelleen (muuten change ei laukea)
        fileInput.value = '';
      }
    };

    // Kuvan osoite (URL) tiedoston sijaan: selain lataa kuvan, jotta mitat saadaan
    // luettua (palvelin ei hae ulkoisia kuvia). Vain http(s)-osoitteet hyväksytään.
    const urlInput = box.querySelector('.image-url-input');
    urlInput.addEventListener('change', () => {
      const url = urlInput.value.trim();
      status.classList.remove('is-error');
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) {
        status.textContent = 'Osoitteen on alettava http:// tai https://.';
        status.classList.add('is-error');
        return;
      }
      const img = new Image();
      img.onload = () => {
        hidden.value = url;
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
        preview.innerHTML = `<img src="${esc(url)}" alt="">`;
        status.textContent = `Kuva osoitteesta · ${img.naturalWidth} × ${img.naturalHeight} px`;
        if (f.onUploaded) f.onUploaded({ image_url: url, width: img.naturalWidth, height: img.naturalHeight }, form);
      };
      img.onerror = () => {
        status.textContent = 'Kuvaa ei voitu ladata osoitteesta.';
        status.classList.add('is-error');
      };
      img.src = url;
    });

    fileInput.addEventListener('change', () => handle(fileInput.files[0]));
    // preventDefault on pakollinen: ilman sitä selain ei salli pudotusta ja
    // avaisi raahatun kuvan kokonaan uuteen näkymään
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-dragover');
      handle(e.dataTransfer.files[0]);
    });
  };

  /**
   * Monivalinnan yhteenveto: valittujen nimet (tai "3 valittu") pudotusvalikon otsikkoon.
   * Valikko sulkeutuu, kun klikataan sen ulkopuolelle.
   */
  const attachMultiselect = (form, f) => {
    const box = form.querySelector(`[data-multiselect="${f.name}"]`);
    const summary = box.querySelector('summary');
    const update = () => {
      const names = [...box.querySelectorAll('input:checked')]
        .map((i) => i.closest('.check').textContent.trim());
      summary.textContent = !names.length ? (f.placeholder || 'Valitse')
        : names.length <= 2 ? names.join(', ') : `${names.length} valittu`;
    };
    box.addEventListener('change', update);
    form.addEventListener('click', (e) => { if (!box.contains(e.target)) box.open = false; });
    update();
  };

  /**
   * Pieni valintaikkuna, jossa on otsikko, teksti tai HTML ja painikkeet.
   * Palauttaa lupauksen, joka ratkeaa painetun painikkeen arvolla (× tai Esc -> null).
   * Ikkuna avautuu muiden ikkunoiden päälle (selaimen top layer).
   * @param {object} o  { title, message (teksti) tai html, buttons: [{ value, label, cls }], wide,
   *                     onDone(value, dialog) }  onDone (valinnainen) kutsutaan ennen ikkunan
   *                     poistamista, joten sillä voi lukea ikkunan kenttien arvot (esim. suodattimet).
   */
  const choiceDialog = ({ title, message = '', html = '', buttons, wide = false, onDone }) => new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = `modal ${wide ? '' : 'modal-small'}`;
    dialog.innerHTML = `
      <header class="modal-header">
        <h2>${esc(title)}</h2>
        <button type="button" class="modal-close" aria-label="Sulje">×</button>
      </header>
      <div class="modal-body">${html || `<p>${esc(message)}</p>`}</div>
      <footer class="modal-footer">
        <span class="spacer"></span>
        ${buttons.map((b, i) => `<button type="button" class="btn ${b.cls || 'btn-secondary'}" data-i="${i}">${esc(b.label)}</button>`).join('')}
      </footer>`;
    document.body.appendChild(dialog);
    const done = (value) => {
      if (onDone) onDone(value, dialog);
      dialog.close(); dialog.remove(); resolve(value);
    };
    dialog.querySelector('.modal-close').addEventListener('click', () => done(null));
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    dialog.querySelectorAll('[data-i]').forEach((btn) =>
      btn.addEventListener('click', () => done(buttons[Number(btn.dataset.i)].value)));
    dialog.showModal();
    dialog.querySelector('[data-i]:last-child').focus();
  });

  /** Vahvistuskysymys (esim. poisto). Palauttaa true, jos käyttäjä vahvistaa. */
  const confirmDialog = async ({ title = 'Vahvista', message, confirmLabel = 'Poista', cancelLabel = 'Peruuta',
                                 confirmCls = 'btn-danger' }) =>
    (await choiceDialog({
      title, message,
      buttons: [{ value: false, label: cancelLabel }, { value: true, label: confirmLabel, cls: confirmCls }],
    })) === true;

  /**
   * Ilmoitusikkuna (wireframet: esim. "Kampanja luotu", "Salasanasi on vaihdettu"):
   * pelkkä viesti ja sulkuruksi (×), sulkeutuu myös Esc-näppäimellä ja klikkaamalla
   * ikkunan ulkopuolelle. Palauttaa lupauksen, joka ratkeaa, kun ikkuna suljetaan.
   * type 'error' näyttää viestin punaisena (virheilmoitus).
   */
  const noticeDialog = ({ title = '', message, type = 'success' }) => new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = `modal modal-small modal-notice is-${type}`;
    dialog.setAttribute('role', type === 'error' ? 'alertdialog' : 'dialog');
    dialog.innerHTML = `
      <header class="modal-header">
        <h2>${esc(title)}</h2>
        <button type="button" class="modal-close" aria-label="Sulje">×</button>
      </header>
      <div class="modal-body"><p class="notice-message">${esc(message)}</p></div>`;
    document.body.appendChild(dialog);
    const done = () => { dialog.close(); dialog.remove(); resolve(); };
    dialog.querySelector('.modal-close').addEventListener('click', done);
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); done(); });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) done(); });
    dialog.showModal();
    dialog.querySelector('.modal-close').focus();
  });

  /**
   * Vaihtaa lomakkeen monivalinnan (type 'multiselect') vaihtoehdot lennosta, esim. kun
   * kampanjalomakkeen mainostaja vaihtuu ja Mainokset-listan pitää näyttää sen mainokset.
   * selected = valittuina pidettävät arvot.
   */
  const setMultiselectOptions = (form, name, options, selected = []) => {
    const box = form.querySelector(`[data-multiselect="${name}"]`);
    if (!box) return;
    const sel = new Set(selected.map(String));
    box.querySelector('.check-group').innerHTML = options.length
      ? options.map((o) => `<label class="check"><input type="checkbox" name="${name}" value="${esc(o.value)}" ${sel.has(String(o.value)) ? 'checked' : ''}> ${esc(o.label)}</label>`).join('')
      : `<span class="cell-muted">${esc(box.dataset.empty || 'Ei vaihtoehtoja')}</span>`;
    box.dispatchEvent(new Event('change'));   // päivittää yhteenvedon (attachMultiselect)
  };

  /**
   * Avaa modaalisen lomakeikkunan (ks. parametrit yllä olevasta kommentista).
   * Ikkuna luodaan joka kerta uudelleen ja poistetaan DOMista suljettaessa,
   * joten vanhat arvot tai tapahtumankäsittelijät eivät jää roikkumaan.
   * @returns {HTMLDialogElement} avattu ikkuna
   */
  /* ---------- Lomakkeen tarkistus (pakolliset ja virheelliset kentät) ----------
     Kun käyttäjä painaa lomakkeen pääpainiketta (esim. Luo / Tallenna), jokainen kenttä
     tarkistetaan. Virheellisen kentän alle tulee punainen viesti, joka kertoo mikä on
     vialla (esim. "Mainoksen nimi on pakollinen tieto."), kenttä saa punaisen reunan, ja
     lomakkeen alareunaan tulee yhteenveto ("Lomakkeesta puuttuu tietoja…"). Ensimmäinen
     virheellinen kenttä vieritetään näkyviin ja fokusoidaan.
     Kun kenttää korjataan, sen viesti päivittyy heti. Kentästä poistuttaessa (blur)
     tarkistetaan myös kentät, joita käyttäjä on jo muokannut, joten puute näkyy
     jo ennen tallennusyritystä.
     Tarkistuksen lähteet:
       - kentän HTML-säännöt (required, type=url/email/number, pattern, min, max, maxlength)
       - pakollinen kuva (image) ja pakollinen valintaryhmä (checkboxes: vähintään yksi)
       - kentän oma sääntö f.validate(value, form) -> virheteksti tai ''
       - kentän setCustomValidity-viesti (esim. "Samanniminen mainospaikka on jo olemassa.")
       - lomakkeen yhteiset säännöt openForm({ validate: (data) => ({ kenttä: 'viesti' }) }),
         esim. päättymispäivä ennen aloituspäivää
     f.patternMessage = selkokielinen ohje pattern-säännölle (muuten käytetään kentän ohjetta). */

  /** Kentän virheteksti selaimen validointitilan perusteella ('' = kunnossa). */
  const fieldMessage = (f, el) => {
    const v = el.validity;
    const label = f.label.replace(/\s*\*$/, '');
    if (v.valid) return '';
    if (v.valueMissing) {
      return f.type === 'select' ? `Valitse ${label.toLowerCase()} – pakollinen tieto.`
        : `${label} on pakollinen tieto.`;
    }
    if (v.badInput) return f.type === 'date' ? 'Anna päivämäärä muodossa pp.kk.vvvv.' : 'Anna luku.';
    if (v.typeMismatch) {
      if (f.type === 'url') return 'Anna kelvollinen osoite, joka alkaa http:// tai https://.';
      if (f.type === 'email') return 'Anna kelvollinen sähköpostiosoite (esim. nimi@louhi.fi).';
    }
    if (v.rangeUnderflow || v.rangeOverflow) {
      return f.min !== undefined && f.max !== undefined ? `Anna luku väliltä ${f.min}–${f.max}.`
        : v.rangeUnderflow ? `Pienin sallittu arvo on ${f.min}.` : `Suurin sallittu arvo on ${f.max}.`;
    }
    if (v.stepMismatch) return 'Anna kokonaisluku.';
    if (v.tooLong) return `Enintään ${f.maxlength} merkkiä.`;
    if (v.patternMismatch) return f.patternMessage || (f.help ? `Arvo ei ole sallitussa muodossa. ${f.help}` : 'Arvo ei ole sallitussa muodossa.');
    if (v.customError) return el.validationMessage;
    return el.validationMessage || 'Tarkista tämä kenttä.';
  };

  /** Tarkistaa yhden kentän (ilman lomakkeen yhteisiä sääntöjä). Palauttaa virhetekstin tai ''. */
  const checkField = (form, f) => {
    if (f.type === 'checkboxes' || f.type === 'multiselect') {
      if (!f.required) return '';
      const checked = form.querySelectorAll(`input[name="${f.name}"]:checked:not(:disabled)`).length;
      return checked ? '' : `Valitse vähintään yksi: ${f.label.replace(/\s*\*$/, '').toLowerCase()}.`;
    }
    const el = form.elements[f.name];
    if (!el) return '';
    if (f.type === 'image') {
      if (form.dataset.uploading) return '';
      return f.required && !el.value ? `${f.label}: lataa kuva (JPG tai PNG) tai anna kuvan osoite.` : '';
    }
    if (el.readOnly) return '';
    const own = fieldMessage(f, el);
    if (own) return own;
    return f.validate ? (f.validate(el.value.trim(), form) || '') : '';
  };

  /** Näyttää tai poistaa kentän virheviestin (punainen teksti kentän alla, punainen reuna). */
  const setFieldError = (form, name, message) => {
    const box = form.querySelector(`[data-field="${name}"]`);
    if (!box) return;
    let msg = box.querySelector(':scope > .field-error');
    box.classList.toggle('has-error', Boolean(message));
    const control = box.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=file]), select, textarea');
    if (control) control.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (!message) { if (msg) msg.remove(); return; }
    if (!msg) {
      msg = document.createElement('small');
      msg.className = 'field-error';
      msg.id = `err-${name}`;
      msg.setAttribute('role', 'alert');
      box.appendChild(msg);
      if (control) control.setAttribute('aria-describedby', msg.id);
    }
    msg.textContent = message;
  };

  /**
   * Tarkistaa koko lomakkeen ja näyttää virheet kenttien alla.
   * @returns {string[]} virheellisten kenttien nimet lomakkeen järjestyksessä
   */
  const validateForm = (form, fields, formRule) => {
    const errors = {};
    fields.forEach((f) => { const m = checkField(form, f); if (m) errors[f.name] = m; });
    if (formRule) {
      const extra = formRule(readForm(form, fields), form) || {};
      Object.entries(extra).forEach(([k, m]) => { if (m && !errors[k]) errors[k] = m; });
    }
    fields.forEach((f) => setFieldError(form, f.name, errors[f.name] || ''));
    return fields.map((f) => f.name).filter((n) => errors[n]);
  };

  /** Kenttien tarkistus muokattaessa: korjaus poistaa viestin heti, puute näkyy kentästä poistuttaessa. */
  const attachLiveValidation = (form, fields, formRule) => {
    const touched = new Set();
    const recheck = (name) => {
      const f = fields.find((x) => x.name === name);
      if (!f) return;
      if (!(form.dataset.validated || touched.has(name))) return;
      let m = checkField(form, f);
      if (!m && formRule) m = (formRule(readForm(form, fields), form) || {})[name] || '';
      setFieldError(form, name, m);
      // Lomakkeen yhteinen sääntö voi koskea toista kenttää (esim. päivämääräpari)
      if (formRule && form.dataset.validated) {
        const extra = formRule(readForm(form, fields), form) || {};
        fields.forEach((x) => {
          if (x.name !== name && form.querySelector(`[data-field="${x.name}"].has-error`) && !checkField(form, x)) {
            setFieldError(form, x.name, extra[x.name] || '');
          }
        });
      }
    };
    const nameOf = (el) => el.closest('[data-field]')?.dataset.field;
    form.addEventListener('input', (e) => {
      const n = nameOf(e.target); if (!n) return;
      touched.add(n);
      // Kirjoitettaessa vain poistetaan korjattu virhe (ei uutta viestiä kesken kirjoituksen)
      if (form.querySelector(`[data-field="${n}"].has-error`)) recheck(n);
    });
    form.addEventListener('change', (e) => { const n = nameOf(e.target); if (n) { touched.add(n); recheck(n); } });
    form.addEventListener('focusout', (e) => { const n = nameOf(e.target); if (n) recheck(n); });
    return recheck;
  };

  const openForm = ({ title, fields, values = {}, submitLabel = 'Tallenna', onSubmit, onDelete, onRender,
                      deleteLabel = 'Poista', deleteConfirm = 'Haluatko varmasti poistaa? Toimintoa ei voi perua.',
                      deleteConfirmLabel = 'Poista', busyLabel = 'Tallennetaan…', headerHtml = '',
                      validate = null }) => {
    // Natiivi <dialog> + showModal(): selain hoitaa taustan estämisen, fokuksen
    // pysymisen ikkunassa ja Esc-näppäimen. novalidate: selain ei estä lähetystä
    // itse, vaan submit-käsittelijä tarkistaa kentät reportValidity():llä.
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.innerHTML = `
      <form method="dialog" class="modal-form" novalidate>
        <header class="modal-header">
          <h2>${esc(title)}</h2>
          <button type="button" class="modal-close" aria-label="Sulje">×</button>
        </header>
        <div class="modal-body">
          ${headerHtml}
          <div class="form-grid">${fields.map((f) => renderField(f, values[f.name])).join('')}</div>
          ${fields.some((f) => f.required) ? '<p class="form-required-note">* = pakollinen tieto</p>' : ''}
          <div class="form-error" role="alert" hidden></div>
        </div>
        <footer class="modal-footer">
          ${onDelete ? `<button type="button" class="btn btn-danger" data-action="delete">${esc(deleteLabel)}</button>` : ''}
          <span class="spacer"></span>
          <button type="button" class="btn btn-secondary" data-action="cancel">Peruuta</button>
          <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>
        </footer>
      </form>`;
    document.body.appendChild(dialog);

    const form = dialog.querySelector('form');
    const errorBox = dialog.querySelector('.form-error');
    const submitBtn = form.querySelector('button[type="submit"]');

    const close = () => { dialog.close(); dialog.remove(); };
    const showError = (msg) => { errorBox.textContent = msg; errorBox.hidden = false; };
    // Painikkeet pois käytöstä tallennuksen ajaksi -> ei tuplalähetyksiä
    const busy = (on) => form.querySelectorAll('button').forEach((b) => { b.disabled = on; });

    dialog.querySelector('.modal-close').addEventListener('click', close);
    form.querySelector('[data-action="cancel"]').addEventListener('click', close);
    // Esc: oletuksena dialog vain piilotettaisiin; close() myös poistaa sen DOMista
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); }); // Esc

    form.addEventListener('submit', async (e) => {
      // method="dialog" sulkisi ikkunan heti; estetään, jotta ikkuna pysyy auki
      // kunnes tallennus onnistuu ja virheet voidaan näyttää ikkunassa
      e.preventDefault();
      errorBox.hidden = true;
      if (form.dataset.uploading) { showError('Odota, kuvaa ladataan vielä.'); return; }
      // Kaikki kentät tarkistetaan: virheet kenttien alle ja yhteenveto lomakkeen alareunaan
      form.dataset.validated = '1';
      const invalid = validateForm(form, fields, validate);
      if (invalid.length) {
        const missing = invalid.filter((n) => {
          const f = fields.find((x) => x.name === n);
          const el = form.elements[n];
          return f.required && (f.type === 'checkboxes' || f.type === 'image' || (el && el.validity && el.validity.valueMissing));
        }).length;
        showError(invalid.length === 1
          ? (missing ? 'Pakollinen tieto puuttuu. Täydennä punaisella merkitty kenttä.'
            : 'Lomakkeessa on virhe. Korjaa punaisella merkitty kenttä.')
          : `Lomakkeessa on ${invalid.length} puuttuvaa tai virheellistä tietoa. Korjaa punaisella merkityt kentät.`);
        const firstBox = form.querySelector(`[data-field="${invalid[0]}"]`);
        firstBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const focusEl = firstBox.querySelector('input:not([type=hidden]):not([readonly]), select, textarea, .image-drop');
        if (focusEl) focusEl.focus({ preventScroll: true });
        return;
      }
      busy(true);
      submitBtn.textContent = busyLabel;
      try {
        // false = jää auki ilman virhettä (esim. käyttäjä palasi esikatselusta muokkaamaan)
        if (await onSubmit(readForm(form, fields)) === false) {
          busy(false);
          submitBtn.textContent = submitLabel;
          return;
        }
        close();
      } catch (err) {
        // Virhe (esim. backendin validointi) näytetään ikkunassa; käyttäjän
        // syöttämät tiedot säilyvät, joten korjaus ja uusi yritys onnistuvat
        showError(err.message);
        busy(false);
        submitBtn.textContent = submitLabel;
      }
    });

    if (onDelete) {
      form.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        if (!(await confirmDialog({ title: deleteLabel, message: deleteConfirm,
          confirmLabel: deleteConfirmLabel }))) return;
        busy(true);
        try {
          await onDelete();
          close();
        } catch (err) {
          showError(err.message);
          busy(false);
        }
      });
    }

    attachLiveValidation(form, fields, validate);
    fields.filter((f) => f.type === 'image').forEach((f) => attachImageField(form, f));
    fields.filter((f) => f.type === 'multiselect').forEach((f) => attachMultiselect(form, f));
    if (onRender) onRender(form);
    dialog.showModal();
    // Fokus ensimmäiseen kenttään, jotta näppäimistökäyttäjä voi kirjoittaa heti
    // (muuten selain fokusoisi ensimmäisen painikkeen eli sulkurastin)
    const first = form.querySelector('input, select, textarea');
    if (first) first.focus();
    return dialog;
  };

  /**
   * Pelkkä sisältöikkuna (esikatselu, upotuskoodi).
   * HUOM: html lisätään sellaisenaan -> kutsujan vastuulla escapettaa
   * käyttäjän syöte UI.esc():llä. title escapetaan täällä.
   * Sulkeutuu ×:stä, Esc:stä ja klikkauksesta ikkunan ulkopuolelle.
   */
  const openInfo = (title, html) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.innerHTML = `
      <header class="modal-header">
        <h2>${esc(title)}</h2>
        <button type="button" class="modal-close" aria-label="Sulje">×</button>
      </header>
      <div class="modal-body">${html}</div>`;
    document.body.appendChild(dialog);
    const close = () => { dialog.close(); dialog.remove(); };
    dialog.querySelector('.modal-close').addEventListener('click', close);
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    // Taustan (::backdrop) klikkaus kohdistuu itse dialog-elementtiin
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
    dialog.showModal();
    return dialog;
  };

  /* ---------- ?-ohjeiden tooltipit ----------
     Teksti näytetään omassa elementissään (position: fixed) ja sijoitetaan JS:llä:
     ensisijaisesti ?-merkin yläpuolelle keskitettynä, mutta siirrettynä ruudun sisään,
     ja ?-merkin alle, jos yläpuolella ei ole tilaa. Pelkkä CSS (::after) leikkautui
     modaalin vierityslaatikon (overflow) reunaan. Elementti lisätään samaan ikkunaan
     (dialog) kuin ?-merkki, koska avoin modaali on selaimen ylimmällä tasolla (top layer)
     ja peittäisi bodyyn lisätyn elementin. */
  let tooltipEl = null;
  const hideTooltip = () => { if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; } };
  const showTooltip = (anchor) => {
    hideTooltip();
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'tooltip-pop';
    tooltipEl.setAttribute('role', 'tooltip');
    tooltipEl.textContent = anchor.dataset.tip;
    const dialog = anchor.closest('dialog');
    (dialog || document.body).appendChild(tooltipEl);
    const a = anchor.getBoundingClientRect();
    const t = tooltipEl.getBoundingClientRect();
    const margin = 8;
    // Vaakasuunnassa pidetään teksti modaalin (tai ruudun) sisällä
    const box = dialog ? dialog.getBoundingClientRect() : { left: 0, right: window.innerWidth };
    const minLeft = Math.max(margin, box.left + margin);
    const maxLeft = Math.min(window.innerWidth, box.right) - t.width - margin;
    let left = a.left + a.width / 2 - t.width / 2;
    left = Math.max(minLeft, Math.min(left, maxLeft));
    let top = a.top - t.height - margin;
    if (top < margin) top = a.bottom + margin;   // ei tilaa yläpuolella -> alle
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  };
  // Event delegation koko dokumenttiin: toimii myös myöhemmin luoduissa lomakkeissa.
  document.addEventListener('mouseover', (e) => {
    const tipEl = e.target.closest?.('.help-tip');
    if (tipEl) showTooltip(tipEl);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest?.('.help-tip')) hideTooltip();
  });
  document.addEventListener('focusin', (e) => {
    if (e.target.classList?.contains('help-tip')) showTooltip(e.target);
  });
  document.addEventListener('focusout', hideTooltip);
  // Vieritys tai ikkunan sulkeminen: piilotetaan, ettei teksti jää väärään kohtaan
  document.addEventListener('scroll', hideTooltip, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTooltip(); });

  // Julkinen rajapinta: sivuskriptit käyttävät näitä muodossa UI.esc(...), UI.toast(...)
  /* ---------- Sivutus (listasivut) ----------
     Listat haetaan kokonaisina ja suodatetaan; sivutus näyttää niistä 20 riviä kerrallaan.
     Käyttö listasivulla:
       const pager = UI.pager(document.getElementById('x-pager'), () => render());
       const rows = pager.slice(filteredList);   // tämän sivun rivit; piirtää myös navigaation
       pager.reset();                            // suodatuksen muuttuessa takaisin sivulle 1
     Navigaatio: < Edellinen  1 … 4 5 6 … 12  Seuraava >. Yhden sivun listassa se on piilossa.
     Jos sivu jää tyhjäksi (esim. viimeisen sivun viimeinen rivi poistettiin), siirrytään
     viimeiselle sivulle, jolla on rivejä. */
  const PAGE_SIZE = 20;

  /** Näytettävät sivunumerot: ensimmäinen, viimeinen ja nykyisen ympäristö; väliin '…'. */
  const pageNumbers = (page, pages) => {
    const wanted = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
    const sorted = [...wanted].sort((a, b) => a - b);
    const out = [];
    sorted.forEach((n, i) => {
      if (i && n - sorted[i - 1] > 1) out.push(n - sorted[i - 1] === 2 ? n - 1 : '…');
      out.push(n);
    });
    return out;
  };

  const pager = (container, onChange, pageSize = PAGE_SIZE) => {
    let page = 1;
    const draw = (total) => {
      const pages = Math.max(1, Math.ceil(total / pageSize));
      if (pages <= 1) { container.innerHTML = ''; container.hidden = true; return; }
      container.hidden = false;
      const first = (page - 1) * pageSize + 1;
      const last = Math.min(page * pageSize, total);
      container.innerHTML = `
        <span class="pager-info">${first}–${last} / ${total}</span>
        <nav class="pager-pages" aria-label="Sivutus">
          <button type="button" class="pager-btn pager-prev" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>‹ Edellinen</button>
          ${pageNumbers(page, pages).map((n) => (n === '…'
            ? '<span class="pager-gap">…</span>'
            : `<button type="button" class="pager-btn${n === page ? ' is-current' : ''}" data-page="${n}"
                 ${n === page ? 'aria-current="page"' : ''}>${n}</button>`)).join('')}
          <button type="button" class="pager-btn pager-next" data-page="${page + 1}" ${page === pages ? 'disabled' : ''}>Seuraava ›</button>
        </nav>`;
    };
    container.classList.add('pager');
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-page]');
      if (!btn || btn.disabled) return;
      page = Number(btn.dataset.page);
      onChange();
      // Lista alkaa sivun yläosasta: vieritetään listan alkuun, ettei jäädä sivun pohjalle
      container.closest('.section-card')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return {
      /** Palauttaa nykyisen sivun rivit ja piirtää navigaation. */
      slice(list) {
        const pages = Math.max(1, Math.ceil(list.length / pageSize));
        if (page > pages) page = pages;
        draw(list.length);
        return list.slice((page - 1) * pageSize, page * pageSize);
      },
      reset() { page = 1; },
      get page() { return page; },
    };
  };

  return {
    esc, fmtInt, fmtPct, fmtDate, fmtRange, isoToDateInput, dateInputToIso,
    STATUS, pill, tableMessage, toast, openForm, openInfo, choiceDialog, confirm: confirmDialog,
    notice: noticeDialog, setMultiselectOptions, pager, PAGE_SIZE,
  };
})();
