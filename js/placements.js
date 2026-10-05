/* Mainospaikat: listaus, luonti, muokkaus, poisto ja upotuskoodi. */
(() => {
  const tbody = document.getElementById('placements-body');
  const countEl = document.getElementById('placements-count');
  const COLS = 6;
  let placements = [];

  const ENVIRONMENTS = ['Louhi Konsoli', 'www', 'Domain Control Panel', 'Tukiportaali', 'cPanel'];

  const fields = [
    { name: 'name', label: 'Nimi', required: true, maxlength: 150, placeholder: 'Louhi Konsoli – pääbanneri', wide: true },
    { name: 'environment', label: 'Ympäristö', type: 'select', required: true,
      options: ENVIRONMENTS.map((e) => ({ value: e, label: e })) },
    { name: 'status', label: 'Tila', type: 'select', required: true,
      options: [{ value: 'active', label: 'Aktiivinen' }, { value: 'inactive', label: 'Ei aktiivinen' }] },
    { name: 'width', label: 'Mainoksen leveys (px)', type: 'number', required: true, min: 1, max: 5000 },
    { name: 'height', label: 'Mainoksen korkeus (px)', type: 'number', required: true, min: 1, max: 5000 },
    { name: 'notes', label: 'Tekniset huomiot', type: 'textarea' },
  ];

  /** Sama sääntö kuin palvelimella (backend/app/slug.py) – käytetään vain esikatseluun. */
  const previewCode = (name) => {
    let slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!slug) slug = 'mainospaikka';
    if (!slug.startsWith('louhi')) slug = `louhi_${slug}`;
    return slug.slice(0, 60).replace(/_+$/, '');
  };

  /** Näyttää Placement ID:n lomakkeessa: uudelle esikatselu, olemassa olevalle lukittu arvo. */
  const attachCodePreview = (placement) => (form) => {
    const box = document.createElement('div');
    box.className = 'field field-wide';
    box.innerHTML = `
      <span class="field-label">Placement ID</span>
      <div class="code-preview" aria-live="polite"></div>
      <small class="field-help">${placement
        ? 'Tunnusta ei voi muuttaa, koska se on upotettu sivustojen koodiin.'
        : 'Muodostuu automaattisesti nimestä. Käytetään upotuskoodissa.'}</small>`;
    form.elements.name.closest('.field').after(box);
    const out = box.querySelector('.code-preview');
    if (placement) {
      out.textContent = placement.code;
      return;
    }
    const update = () => {
      const name = form.elements.name.value.trim();
      out.textContent = name ? previewCode(name) : '–';
      // Jos tunnus on jo käytössä, palvelin lisää perään _2, _3 ...
      const taken = placements.some((p) => p.code === out.textContent);
      out.classList.toggle('is-taken', taken);
      out.title = taken ? 'Tunnus on jo käytössä – tallennettaessa perään lisätään numero.' : '';
    };
    form.elements.name.addEventListener('input', update);
    update();
  };

  const render = () => {
    countEl.textContent = `Kaikki mainospaikat (${placements.length})`;
    if (!placements.length) {
      UI.tableMessage(tbody, COLS, 'Ei vielä mainospaikkoja. Luo ensimmäinen yläkulman painikkeesta.');
      return;
    }
    tbody.innerHTML = placements.map((p) => `
      <tr>
        <td>${UI.esc(p.name)}</td>
        <td class="cell-mono">${UI.esc(p.code)}</td>
        <td class="cell-muted">${UI.esc(p.environment)}</td>
        <td class="cell-muted">${p.width} × ${p.height}</td>
        <td>${UI.pill(p.status)}</td>
        <td class="cell-actions">
          <button class="btn-ghost" data-embed="${p.id}">Upotuskoodi</button>
          <button class="btn-ghost admin-only" data-edit="${p.id}">Muokkaa</button>
        </td>
      </tr>`).join('');
  };

  const load = async () => {
    UI.tableMessage(tbody, COLS, 'Ladataan…');
    try {
      placements = await Api.get('/api/placements');
      render();
    } catch (err) {
      UI.tableMessage(tbody, COLS, err.message, true);
    }
  };

  const openEditor = (placement) => {
    const isNew = !placement;
    // Ympäristö, jota ei ole listalla (esim. lisätty API:n kautta), lisätään vaihtoehdoksi.
    const envField = fields.find((f) => f.name === 'environment');
    if (placement && !ENVIRONMENTS.includes(placement.environment)) {
      envField.options = [...envField.options, { value: placement.environment, label: placement.environment }];
    }
    UI.openForm({
      title: isNew ? 'Luo uusi mainospaikka' : `Muokkaa: ${placement.name}`,
      fields,
      values: placement || { status: 'active', environment: ENVIRONMENTS[0] },
      submitLabel: isNew ? 'Luo mainospaikka' : 'Tallenna',
      onRender: attachCodePreview(placement),
      onSubmit: async (data) => {
        if (isNew) {
          const created = await Api.post('/api/placements', data);
          UI.toast(`Mainospaikka luotu. Placement ID: ${created.code}`);
        } else {
          await Api.put(`/api/placements/${placement.id}`, data);
          UI.toast('Muutokset tallennettu.');
        }
        load();
      },
      onDelete: isNew ? null : async () => {
        await Api.del(`/api/placements/${placement.id}`);
        UI.toast('Mainospaikka poistettu.');
        load();
      },
    });
  };

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
    dialog.querySelector('[data-copy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
        UI.toast('Upotuskoodi kopioitu leikepöydälle.');
      } catch {
        UI.toast('Kopiointi ei onnistunut – valitse teksti ja kopioi käsin.', 'error');
      }
    });
  };

  tbody.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    const embed = e.target.closest('[data-embed]');
    if (edit) openEditor(placements.find((p) => p.id === Number(edit.dataset.edit)));
    if (embed) showEmbed(placements.find((p) => p.id === Number(embed.dataset.embed)));
  });
  document.getElementById('new-placement').addEventListener('click', () => openEditor(null));

  load();
})();
