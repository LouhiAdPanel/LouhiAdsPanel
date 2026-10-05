/* Mainokset: ruudukko, suodatus kampanjalla, luonti, muokkaus, esikatselu. */
(() => {
  const grid = document.getElementById('creatives-grid');
  const countEl = document.getElementById('creatives-count');
  const filter = document.getElementById('creatives-campaign-filter');
  let creatives = [];
  let campaigns = [];

  const params = new URLSearchParams(window.location.search);
  const initialCampaign = params.get('campaign_id') || '';

  const fields = () => [
    { name: 'campaign_id', label: 'Kampanja', type: 'select', required: true, numeric: true, wide: true,
      options: [{ value: '', label: '– Valitse kampanja –' },
        ...campaigns.map((c) => ({ value: c.id, label: `${c.name} (${c.advertiser_name})` }))] },
    { name: 'name', label: 'Mainoksen nimi', required: true, maxlength: 150, placeholder: 'Banneri A' },
    { name: 'status', label: 'Tila', type: 'select', required: true,
      options: [{ value: 'active', label: 'Aktiivinen' }, { value: 'inactive', label: 'Ei aktiivinen' }] },
    { name: 'image_url', label: 'Mainoskuva', type: 'image', required: true,
      help: 'JPG tai PNG, enintään 5 Mt.',
      upload: (file) => Api.upload('/api/creatives/upload', file),
      // Mitat täytetään kuvasta automaattisesti
      onUploaded: (img, form) => {
        form.elements.width.value = img.width;
        form.elements.height.value = img.height;
      } },
    { name: 'target_url', label: 'Kohde-URL', type: 'url', required: true, wide: true,
      placeholder: 'https://www.saashop.fi/', help: 'UTM-parametrit lisätään klikatessa automaattisesti.' },
    { name: 'alt_text', label: 'ALT-teksti', maxlength: 200, wide: true, emptyValue: '',
      placeholder: 'Lyhyt kuvaus mainoksesta (saavutettavuus)' },
    { name: 'width', label: 'Leveys (px)', type: 'number', min: 1 },
    { name: 'height', label: 'Korkeus (px)', type: 'number', min: 1 },
    { name: 'weight', label: 'Näyttöpaino (0–100)', type: 'number', required: true, min: 0, max: 100,
      help: 'Suhteellinen osuus näytöistä. Sama paino kaikilla = tasajako. 0 = ei näytetä.' },
  ];

  const thumb = (c) => c.image_url
    ? `<img src="${UI.esc(c.image_url)}" alt="${UI.esc(c.alt_text)}" loading="lazy">`
    : `${c.width || '?'} × ${c.height || '?'}`;

  const render = () => {
    countEl.textContent = `Mainokset (${creatives.length})`;
    if (!creatives.length) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <span class="plus-badge">+</span>
          <span>Ei mainoksia${filter.value ? ' tässä kampanjassa' : ''}. Lisää mainos yläkulman painikkeesta.</span>
        </div>`;
      return;
    }
    grid.innerHTML = creatives.map((c) => `
      <div class="creative-card">
        <div class="creative-thumb">${thumb(c)}</div>
        <div class="creative-body">
          <h3>${UI.esc(c.name)}</h3>
          <p class="creative-meta">${UI.esc(c.campaign_name)} · ${UI.esc(c.advertiser_name)}</p>
          <p class="creative-meta">${c.width && c.height ? `${c.width} × ${c.height} · ` : ''}paino ${c.weight}</p>
          <div class="creative-footer">
            ${UI.pill(c.status)}
            <span>
              <button class="btn-ghost" data-preview="${c.id}">Esikatsele</button>
              <button class="btn-ghost" data-edit="${c.id}">Muokkaa</button>
            </span>
          </div>
        </div>
      </div>`).join('');
  };

  const loadCreatives = async () => {
    grid.innerHTML = '<p class="table-message">Ladataan…</p>';
    try {
      creatives = await Api.get('/api/creatives', { campaign_id: filter.value });
      render();
    } catch (err) {
      grid.innerHTML = `<p class="table-message is-error">${UI.esc(err.message)}</p>`;
    }
  };

  const loadCampaigns = async () => {
    campaigns = await Api.get('/api/campaigns');
    filter.innerHTML = '<option value="">Kaikki kampanjat</option>' +
      campaigns.map((c) => `<option value="${c.id}">${UI.esc(c.name)}</option>`).join('');
    filter.value = initialCampaign;
  };

  const openEditor = (creative) => {
    const isNew = !creative;
    if (!campaigns.length) {
      UI.toast('Luo ensin kampanja, johon mainos liitetään.', 'error');
      return;
    }
    UI.openForm({
      title: isNew ? 'Uusi mainos' : `Muokkaa: ${creative.name}`,
      fields: fields(),
      values: creative || { status: 'active', weight: 1, campaign_id: filter.value || '' },
      submitLabel: isNew ? 'Lisää mainos' : 'Tallenna',
      onSubmit: async (data) => {
        if (isNew) await Api.post('/api/creatives', data);
        else await Api.put(`/api/creatives/${creative.id}`, data);
        UI.toast(isNew ? 'Mainos lisätty.' : 'Muutokset tallennettu.');
        loadCreatives();
      },
      onDelete: isNew ? null : async () => {
        await Api.del(`/api/creatives/${creative.id}`);
        UI.toast('Mainos poistettu.');
        loadCreatives();
      },
    });
  };

  const openPreview = (c) => {
    UI.openInfo(c.name, `
      <div class="preview-frame">
        <a href="${UI.esc(c.target_url)}" target="_blank" rel="noopener">
          <img src="${UI.esc(c.image_url)}" alt="${UI.esc(c.alt_text)}">
        </a>
      </div>
      <dl class="detail-list">
        <dt>Kampanja</dt><dd>${UI.esc(c.campaign_name)}</dd>
        <dt>Kohde-URL</dt><dd><a href="${UI.esc(c.target_url)}" target="_blank" rel="noopener">${UI.esc(c.target_url)}</a></dd>
        <dt>ALT-teksti</dt><dd>${UI.esc(c.alt_text || '–')}</dd>
        <dt>Koko</dt><dd>${c.width && c.height ? `${c.width} × ${c.height} px` : '–'}</dd>
        <dt>Näyttöpaino</dt><dd>${c.weight}</dd>
      </dl>`);
  };

  grid.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    const prev = e.target.closest('[data-preview]');
    if (edit) openEditor(creatives.find((c) => c.id === Number(edit.dataset.edit)));
    if (prev) openPreview(creatives.find((c) => c.id === Number(prev.dataset.preview)));
  });
  filter.addEventListener('change', loadCreatives);
  document.getElementById('new-creative').addEventListener('click', () => openEditor(null));

  loadCampaigns()
    .catch((err) => UI.toast(err.message, 'error'))
    .finally(loadCreatives);
})();
