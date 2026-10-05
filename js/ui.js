/* ============================================================
   LOUHI ADS — yhteiset käyttöliittymäapurit
   Muotoilu (luvut, päivät), tilamerkit, ilmoitukset (toast)
   ja yleiskäyttöinen lomakeikkuna (<dialog>).
   ============================================================ */

const UI = (() => {
  /* ---------- Turvallisuus: käyttäjän syöte aina escapettuna HTML:ään ---------- */
  const esc = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  /* ---------- Muotoilu (suomalainen esitystapa) ---------- */
  const numberFmt = new Intl.NumberFormat('fi-FI');
  const pctFmt = new Intl.NumberFormat('fi-FI', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const fmtInt = (n) => (n === null || n === undefined ? '–' : numberFmt.format(n));
  const fmtPct = (n) => (n === null || n === undefined ? '–' : `${pctFmt.format(n)} %`);

  const fmtDate = (iso) => {
    if (!iso) return '–';
    const d = new Date(iso);
    return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
  };

  const fmtRange = (start, end) => {
    if (!start && !end) return '–';
    if (!start || !end) return `${fmtDate(start)} – ${fmtDate(end)}`;
    const s = new Date(start);
    const e = new Date(end);
    const sameYear = s.getFullYear() === e.getFullYear();
    return `${s.getDate()}.${s.getMonth() + 1}.${sameYear ? '' : s.getFullYear()}–${fmtDate(end)}`;
  };

  /** ISO-aikaleima -> 'YYYY-MM-DD' (paikallinen aika) <input type="date">:lle */
  const isoToDateInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /** 'YYYY-MM-DD' -> ISO-aikaleima. endOfDay=true -> klo 23:59:59 */
  const dateInputToIso = (value, endOfDay = false) => {
    if (!value) return null;
    const [y, m, d] = value.split('-').map(Number);
    const date = endOfDay ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d, 0, 0, 0);
    return date.toISOString();
  };

  /* ---------- Tilamerkit ---------- */
  const STATUS = {
    active:   { label: 'Aktiivinen',        cls: 'pill-active' },
    pending:  { label: 'Odottaa alkamista', cls: 'pill-pending' },
    paused:   { label: 'Keskeytetty',       cls: 'pill-paused' },
    draft:    { label: 'Luonnos',           cls: 'pill-draft' },
    ended:    { label: 'Päättynyt',         cls: 'pill-draft' },
    archived: { label: 'Arkistoitu',        cls: 'pill-draft' },
    inactive: { label: 'Ei aktiivinen',     cls: 'pill-draft' },
  };

  const pill = (status) => {
    const s = STATUS[status] || { label: status, cls: 'pill-draft' };
    return `<span class="pill ${s.cls}">${esc(s.label)}</span>`;
  };

  /* ---------- Taulukon tilat: lataus / tyhjä / virhe ---------- */
  const tableMessage = (tbody, cols, text, isError = false) => {
    tbody.innerHTML = `<tr><td colspan="${cols}" class="table-message${isError ? ' is-error' : ''}">${esc(text)}</td></tr>`;
  };

  /* ---------- Ilmoitukset ---------- */
  let toastBox;
  const toast = (message, type = 'success') => {
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'toast-container';
      toastBox.setAttribute('role', 'status');
      toastBox.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastBox);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
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
     Kenttätyypit: text, url, number, date, select, checkboxes, textarea
  */
  const renderField = (f, value) => {
    const id = `f-${f.name}`;
    const req = f.required ? 'required' : '';
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
    const label = `<label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>`;
    const wide = f.wide ? ' field-wide' : '';

    if (f.type === 'select') {
      const opts = (f.options || [])
        .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`)
        .join('');
      return `<div class="field${wide}">${label}<select id="${id}" name="${f.name}" class="select" ${req}>${opts}</select>${help}</div>`;
    }

    if (f.type === 'checkboxes') {
      const selected = new Set((value || []).map(String));
      const boxes = (f.options || [])
        .map((o) => `<label class="check"><input type="checkbox" name="${f.name}" value="${esc(o.value)}" ${selected.has(String(o.value)) ? 'checked' : ''}> ${esc(o.label)}</label>`)
        .join('');
      return `<fieldset class="field field-wide"><legend>${esc(f.label)}</legend><div class="check-group">${boxes || '<span class="cell-muted">Ei vaihtoehtoja</span>'}</div>${help}</fieldset>`;
    }

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
              <span class="field-help">tai raahaa kuva tähän</span>
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

  const readForm = (form, fields) => {
    const data = {};
    fields.forEach((f) => {
      if (f.type === 'checkboxes') {
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

  const MAX_IMAGE_MB = 5;
  const attachImageField = (form, f) => {
    const box = form.querySelector(`[data-image-field="${f.name}"]`);
    const hidden = box.querySelector(`input[name="${f.name}"]`);
    const fileInput = box.querySelector('input[type="file"]');
    const preview = box.querySelector('.image-drop-preview');
    const status = box.querySelector('.upload-status');
    const drop = box.querySelector('.image-drop');
    const allowed = (f.accept || 'image/png,image/jpeg').split(',');

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
      form.dataset.uploading = '1';
      status.textContent = 'Ladataan kuvaa…';
      try {
        const result = await f.upload(file);
        hidden.value = result.image_url;
        preview.innerHTML = `<img src="${esc(result.image_url)}" alt="">`;
        status.textContent = `${file.name} · ${result.width} × ${result.height} px`;
        box.querySelector('label.btn').firstChild.textContent = 'Vaihda kuva ';
        const formError = form.querySelector('.form-error');
        if (formError) formError.hidden = true;   // aiempi "lataa kuva" -virhe pois
        if (f.onUploaded) f.onUploaded(result, form);
      } catch (err) {
        status.textContent = err.message;
        status.classList.add('is-error');
      } finally {
        delete form.dataset.uploading;
        fileInput.value = '';
      }
    };

    fileInput.addEventListener('change', () => handle(fileInput.files[0]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-dragover');
      handle(e.dataTransfer.files[0]);
    });
  };

  const openForm = ({ title, fields, values = {}, submitLabel = 'Tallenna', onSubmit, onDelete, onRender }) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.innerHTML = `
      <form method="dialog" class="modal-form" novalidate>
        <header class="modal-header">
          <h2>${esc(title)}</h2>
          <button type="button" class="modal-close" aria-label="Sulje">×</button>
        </header>
        <div class="modal-body">
          <div class="form-grid">${fields.map((f) => renderField(f, values[f.name])).join('')}</div>
          <div class="form-error" hidden></div>
        </div>
        <footer class="modal-footer">
          ${onDelete ? '<button type="button" class="btn btn-danger" data-action="delete">Poista</button>' : ''}
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
    const busy = (on) => form.querySelectorAll('button').forEach((b) => { b.disabled = on; });

    dialog.querySelector('.modal-close').addEventListener('click', close);
    form.querySelector('[data-action="cancel"]').addEventListener('click', close);
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); }); // Esc

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.hidden = true;
      if (!form.reportValidity()) return;
      if (form.dataset.uploading) { showError('Odota, kuvaa ladataan vielä.'); return; }
      const missingImage = fields.find((f) => f.type === 'image' && f.required && !form.elements[f.name].value);
      if (missingImage) { showError(`${missingImage.label}: lataa kuva (JPG tai PNG).`); return; }
      busy(true);
      submitBtn.textContent = 'Tallennetaan…';
      try {
        await onSubmit(readForm(form, fields));
        close();
      } catch (err) {
        showError(err.message);
        busy(false);
        submitBtn.textContent = submitLabel;
      }
    });

    if (onDelete) {
      form.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        if (!confirm('Haluatko varmasti poistaa? Toimintoa ei voi perua.')) return;
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
    if (onRender) onRender(form);
    dialog.showModal();
    const first = form.querySelector('input, select, textarea');
    if (first) first.focus();
    return dialog;
  };

  /** Pelkkä sisältöikkuna (esikatselu, upotuskoodi). */
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
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
    dialog.showModal();
    return dialog;
  };

  return {
    esc, fmtInt, fmtPct, fmtDate, fmtRange, isoToDateInput, dateInputToIso,
    STATUS, pill, tableMessage, toast, openForm, openInfo,
  };
})();
