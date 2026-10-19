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
     tooltip (?-ohje otsikon perässä).
     Lomakkeen muut asetukset: deleteLabel, deleteConfirm (vahvistuskysymys),
     deleteConfirmLabel (vahvistuspainikkeen teksti, esim. 'Kyllä'),
     busyLabel (painikkeen teksti käsittelyn aikana). Jos onSubmit palauttaa false,
     ikkuna jää auki ilman virheilmoitusta (esim. "Palaa takaisin muokkaamaan").
  */

  /**
   * Palauttaa yhden lomakekentän HTML:n.
   * @param {object} f  kentän määrittely (ks. yllä)
   * @param {*} value   nykyinen arvo (muokkaustilassa) tai undefined
   * @returns {string} HTML-merkkijono; kaikki tekstit escapetaan esc():llä
   */
  /** ?-ohje kentän otsikon perään. Teksti näytetään hiiren alla ja näppäimistöfokuksessa (CSS). */
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
      return `<div class="field${wide}">${label}<select id="${id}" name="${f.name}" class="select" ${req}>${opts}</select>${help}</div>`;
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
        return `<fieldset class="field field-wide"><legend>${esc(f.label)}${tip(f.tooltip)}</legend>
          <details class="multiselect" data-multiselect="${f.name}">
            <summary class="select">${esc(f.placeholder || 'Valitse')}</summary>
            <div class="check-group">${boxes || '<span class="cell-muted">Ei vaihtoehtoja</span>'}</div>
          </details>${help}</fieldset>`;
      }
      return `<fieldset class="field field-wide"><legend>${esc(f.label)}${tip(f.tooltip)}</legend><div class="check-group">${boxes || '<span class="cell-muted">Ei vaihtoehtoja</span>'}</div>${help}</fieldset>`;
    }

    // Kuvakenttä: varsinainen arvo (ladatun kuvan URL) on piilokentässä, jonka
    // attachImageField täyttää latauksen jälkeen. Tiedostokenttä on piilossa
    // <label class="btn"> sisällä, jotta painike voidaan tyylitellä vapaasti.
    if (f.type === 'image') {
      const preview = value
        ? `<img src="${esc(value)}" alt="">`
        : '<span>Ei kuvaa</span>';
      return `
        <div class="field field-wide image-field" data-image-field="${f.name}">
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
      return `<div class="field field-wide">${label}<textarea id="${id}" name="${f.name}" class="input" rows="3" ${req} ${attrs}>${esc(value ?? '')}</textarea>${help}</div>`;
    }

    return `<div class="field${wide}">${label}<input id="${id}" name="${f.name}" type="${f.type || 'text'}" class="input" value="${esc(value ?? '')}" ${req} ${attrs}>${help}</div>`;
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
  const confirmDialog = async ({ title = 'Vahvista', message, confirmLabel = 'Poista', cancelLabel = 'Peruuta' }) =>
    (await choiceDialog({
      title, message,
      buttons: [{ value: false, label: cancelLabel }, { value: true, label: confirmLabel, cls: 'btn-danger' }],
    })) === true;

  /**
   * Avaa modaalisen lomakeikkunan (ks. parametrit yllä olevasta kommentista).
   * Ikkuna luodaan joka kerta uudelleen ja poistetaan DOMista suljettaessa,
   * joten vanhat arvot tai tapahtumankäsittelijät eivät jää roikkumaan.
   * @returns {HTMLDialogElement} avattu ikkuna
   */
  const openForm = ({ title, fields, values = {}, submitLabel = 'Tallenna', onSubmit, onDelete, onRender,
                      deleteLabel = 'Poista', deleteConfirm = 'Haluatko varmasti poistaa? Toimintoa ei voi perua.',
                      deleteConfirmLabel = 'Poista', busyLabel = 'Tallennetaan…', headerHtml = '' }) => {
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
          <div class="form-error" hidden></div>
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
      if (!form.reportValidity()) return;
      if (form.dataset.uploading) { showError('Odota, kuvaa ladataan vielä.'); return; }
      // Pakollinen kuva tarkistetaan erikseen: piilokenttä ei osallistu
      // selaimen required-validointiin
      const missingImage = fields.find((f) => f.type === 'image' && f.required && !form.elements[f.name].value);
      if (missingImage) { showError(`${missingImage.label}: lataa kuva (JPG tai PNG).`); return; }
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

  // Julkinen rajapinta: sivuskriptit käyttävät näitä muodossa UI.esc(...), UI.toast(...)
  return {
    esc, fmtInt, fmtPct, fmtDate, fmtRange, isoToDateInput, dateInputToIso,
    STATUS, pill, tableMessage, toast, openForm, openInfo, choiceDialog, confirm: confirmDialog,
  };
})();
