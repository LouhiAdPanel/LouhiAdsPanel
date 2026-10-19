/* Mainokset-sivu (creatives.html): ruudukko, suodatus, luonti, muokkaus, esikatselu.
   - Kampanja on valinnainen: mainos voi odottaa ilman kampanjaa.
   - Mainospaikan koko on mainoksen maksimikoko: lomake näyttää, mihin paikkoihin mainos mahtuu.

   Käyttäjä (admin ja editor) voi:
   - selata mainoksia korttiruudukkona ja suodattaa kampanjan mukaan tai "Ilman kampanjaa"
   - ladata mainoskuvan, luoda, muokata ja poistaa mainoksia sekä esikatsella niitä
   Tällä sivulla ei ole vain adminille rajattuja toimintoja.

   API:
   - GET    /api/creatives?campaign_id=  tai  ?unassigned=true   lista
   - POST   /api/creatives/upload        kuvan lataus (palauttaa url, width, height)
   - POST   /api/creatives               uusi mainos
   - PUT    /api/creatives/{id}          päivitys
   - DELETE /api/creatives/{id}          poisto
   - GET    /api/campaigns, /api/placements   suodatin, lomake ja sopivuuslaskenta

   Sivulle voi tulla linkillä creatives.html?campaign_id=5 (Kampanjat-sivulta),
   jolloin suodatin on valmiiksi kyseisessä kampanjassa. */
(() => {
  const grid = document.getElementById('creatives-grid');
  const countEl = document.getElementById('creatives-count');
  const filter = document.getElementById('creatives-campaign-filter');
  let creatives = [];
  let campaigns = [];
  let placements = [];

  // Suodattimen erikoisarvo "Ilman kampanjaa". Tyhjä arvo tarkoittaa jo "kaikki mainokset",
  // joten mainoksille ilman kampanjaa tarvitaan oma arvo; se muutetaan API:lle muotoon
  // unassigned=true (ks. loadCreatives). 'none' ei voi sekoittua kampanjan numeeriseen id:hen.
  const NO_CAMPAIGN = 'none';
  const initialFilter = new URLSearchParams(window.location.search).get('campaign_id') || '';

  // Funktio eikä vakio: kampanjalista on käytettävissä vasta loadLookupsin jälkeen.
  // campaign_id: tyhjä valinta -> null, eli mainos tallennetaan ilman kampanjaa.
  // image_url: kuva ladataan heti valittaessa; leveys ja korkeus luetaan kuvasta
  // (readonly), koska niitä käytetään mainospaikkojen sopivuuden laskemiseen.
  const fields = () => [
    { name: 'campaign_id', label: 'Kampanja', type: 'select', numeric: true, wide: true,
      help: 'Valinnainen. Mainoksen voi liittää kampanjaan myöhemmin.',
      options: [{ value: '', label: '– Ei kampanjaa –' },
        ...campaigns.map((c) => ({ value: c.id, label: `${c.name} (${c.advertiser_name})` }))] },
    { name: 'name', label: 'Mainoksen nimi', required: true, maxlength: 150, placeholder: 'Banneri A' },
    { name: 'status', label: 'Tila', type: 'select', required: true,
      options: [{ value: 'active', label: 'Aktiivinen' }, { value: 'inactive', label: 'Ei aktiivinen' }] },
    { name: 'image_url', label: 'Mainoskuva', type: 'image', required: true,
      help: 'JPG tai PNG, enintään 5 Mt.',
      upload: (file) => Api.upload('/api/creatives/upload', file),
      onUploaded: (img, form) => {
        form.elements.width.value = img.width;
        form.elements.height.value = img.height;
        updateFit(form);
      } },
    { name: 'width', label: 'Leveys (px)', type: 'number', readonly: true, help: 'Luetaan kuvasta.' },
    { name: 'height', label: 'Korkeus (px)', type: 'number', readonly: true, help: 'Luetaan kuvasta.' },
    { name: 'target_url', label: 'Kohde-URL', type: 'url', required: true, wide: true,
      placeholder: 'https://www.saashop.fi/', help: 'UTM-parametrit lisätään klikatessa automaattisesti.' },
    { name: 'alt_text', label: 'ALT-teksti', maxlength: 200, wide: true, emptyValue: '',
      placeholder: 'Lyhyt kuvaus mainoksesta (saavutettavuus)' },
    { name: 'weight', label: 'Näyttöpaino (0–100)', type: 'number', required: true, min: 0, max: 100,
      help: 'Suhteellinen osuus näytöistä. Sama paino kaikilla = tasajako. 0 = ei näytetä.' },
  ];

  /* ---------- Koko vs. mainospaikkojen maksimikoko ----------
     Mainospaikan width/height on suurin sallittu mainoskoko. Mainos näytetään vain paikoissa,
     joihin se mahtuu (molemmat mitat <= paikan mitat). Jos mainos ei mahdu mihinkään
     mahdolliseen paikkaan, sitä ei näytettäisi koskaan, joten tallennus estetään.
     Palvelin tekee saman tarkistuksen (creatives.py, _prepare); tämä on käyttäjälle
     välitön palaute jo lomakkeella. */

  /** Mainospaikat, joihin mainos voi päätyä: kampanjan paikat tai ilman kampanjaa kaikki aktiiviset. */
  const candidatePlacements = (campaignId) => {
    if (!campaignId) return placements.filter((p) => p.status === 'active');
    const campaign = campaigns.find((c) => c.id === Number(campaignId));
    const ids = new Set((campaign?.placements || []).map((p) => p.id));
    return placements.filter((p) => ids.has(p.id));
  };

  /** Mahtuuko w × h -kokoinen mainos mainospaikkaan p. */
  const fits = (w, h, p) => w <= p.width && h <= p.height;

  /**
   * Laskee sopivuuden. Palauttaa { ok, html }. ok=false -> tallennus estetään.
   * ok on true myös silloin, kun mittoja ei vielä tiedetä tai paikkoja ei ole:
   * silloin ei ole mitään, mihin verrata, eikä tallennusta kannata estää.
   * html = lista paikoista vihreällä/punaisella (fit-yes / fit-no) lomakkeeseen ja esikatseluun.
   */
  const fitReport = (w, h, campaignId) => {
    const list = candidatePlacements(campaignId);
    if (!w || !h) return { ok: true, html: '<span class="cell-muted">Lataa kuva nähdäksesi, mihin mainospaikkoihin mainos mahtuu.</span>' };
    if (!list.length) {
      return { ok: true, html: `<span class="cell-muted">${campaignId
        ? 'Kampanjalla ei ole vielä mainospaikkoja.' : 'Aktiivisia mainospaikkoja ei ole.'}</span>` };
    }
    const okCount = list.filter((p) => fits(w, h, p)).length;
    const rows = list.map((p) => `
      <li class="${fits(w, h, p) ? 'fit-yes' : 'fit-no'}">
        ${UI.esc(p.name)} <span>max ${p.width} × ${p.height}</span>
      </li>`).join('');
    const summary = okCount
      ? `Mainos (${w} × ${h}) mahtuu ${okCount}/${list.length} ${campaignId ? 'kampanjan' : 'aktiivisesta'} mainospaikasta.`
      : `Mainos (${w} × ${h}) on liian suuri ${campaignId ? 'kaikkiin kampanjan' : 'kaikkiin aktiivisiin'} mainospaikkoihin. Pienennä kuvaa${campaignId ? ' tai valitse toinen kampanja' : ''}.`;
    return { ok: okCount > 0, html: `<p class="fit-summary${okCount ? '' : ' is-error'}">${summary}</p><ul class="fit-list">${rows}</ul>` };
  };

  // Lomakkeen "Sopivuus mainospaikkoihin" -laatikko. null, kun lomake ei ole auki.
  let fitBox = null;

  /** Päivittää sopivuuslaatikon lomakkeen nykyisillä mitoilla ja kampanjalla. */
  const updateFit = (form) => {
    if (!fitBox) return;
    const w = Number(form.elements.width.value) || 0;
    const h = Number(form.elements.height.value) || 0;
    fitBox.querySelector('.fit-body').innerHTML = fitReport(w, h, form.elements.campaign_id.value).html;
  };

  /**
   * UI.openForm kutsuu tätä (onRender), kun lomake on piirretty. Lisää sopivuuslaatikon
   * korkeuskentän perään ja päivittää sen aina, kun kampanjavalinta vaihtuu, koska
   * kampanja määrää, mihin mainospaikkoihin mainos voi päätyä.
   */
  const attachFitPanel = (form) => {
    fitBox = document.createElement('div');
    fitBox.className = 'field field-wide fit-panel';
    fitBox.innerHTML = '<span class="field-label">Sopivuus mainospaikkoihin</span><div class="fit-body"></div>';
    form.elements.height.closest('.field').after(fitBox);
    form.elements.campaign_id.addEventListener('change', () => updateFit(form));
    updateFit(form);
  };

  /* ---------- Listaus ---------- */

  /** Kortin pikkukuva; jos kuvaa ei ole, näytetään pelkät mitat. */
  const thumb = (c) => c.image_url
    ? `<img src="${UI.esc(c.image_url)}" alt="${UI.esc(c.alt_text)}" loading="lazy">`
    : `${c.width || '?'} × ${c.height || '?'}`;

  /** Piirtää mainoskortit. Tyhjän tilan teksti kertoo, mikä suodatin on päällä. */
  const render = () => {
    countEl.textContent = `Mainokset (${creatives.length})`;
    if (!creatives.length) {
      const where = filter.value === NO_CAMPAIGN ? ' ilman kampanjaa' : filter.value ? ' tässä kampanjassa' : '';
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <span class="plus-badge">+</span>
          <span>Ei mainoksia${where}. Lisää mainos yläkulman painikkeesta.</span>
        </div>`;
      return;
    }
    grid.innerHTML = creatives.map((c) => `
      <div class="creative-card">
        <div class="creative-thumb">${thumb(c)}</div>
        <div class="creative-body">
          <h3>${UI.esc(c.name)}</h3>
          <p class="creative-meta">${c.campaign_id
            ? `${UI.esc(c.campaign_name)} · ${UI.esc(c.advertiser_name)}`
            : '<span class="no-campaign">Ei kampanjaa</span>'}</p>
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

  /** Hakee mainokset suodattimen mukaan ja piirtää ruudukon. */
  const loadCreatives = async () => {
    grid.innerHTML = '<p class="table-message">Ladataan…</p>';
    try {
      // NO_CAMPAIGN -> unassigned=true (vain kampanjattomat). Muuten campaign_id; tyhjä arvo
      // jätetään kyselystä pois (Api.get), jolloin palvelin palauttaa kaikki mainokset.
      const query = filter.value === NO_CAMPAIGN ? { unassigned: true } : { campaign_id: filter.value };
      creatives = await Api.get('/api/creatives', query);
      render();
    } catch (err) {
      grid.innerHTML = `<p class="table-message is-error">${UI.esc(err.message)}</p>`;
    }
  };

  /**
   * Hakee kampanjat ja mainospaikat rinnakkain, täyttää suodattimen ja asettaa
   * URL:n ?campaign_id=-arvon valituksi (asetetaan vasta kun vaihtoehdot ovat olemassa).
   */
  const loadLookups = async () => {
    [campaigns, placements] = await Promise.all([Api.get('/api/campaigns'), Api.get('/api/placements')]);
    filter.innerHTML = '<option value="">Kaikki mainokset</option>' +
      `<option value="${NO_CAMPAIGN}">Ilman kampanjaa</option>` +
      campaigns.map((c) => `<option value="${c.id}">${UI.esc(c.name)}</option>`).join('');
    filter.value = initialFilter;
  };

  /* ---------- Lomake ---------- */

  /**
   * Avaa luonti-/muokkauslomakkeen. creative = null -> uusi mainos.
   * Uusi mainos liitetään oletuksena suodattimessa valittuun kampanjaan (jos sellainen on).
   */
  const openEditor = (creative) => {
    const isNew = !creative;
    const defaultCampaign = filter.value && filter.value !== NO_CAMPAIGN ? filter.value : '';
    UI.openForm({
      title: isNew ? 'Uusi mainos' : `Muokkaa: ${creative.name}`,
      fields: fields(),
      values: creative || { status: 'active', weight: 1, campaign_id: defaultCampaign },
      submitLabel: isNew ? 'Lisää mainos' : 'Tallenna',
      onRender: attachFitPanel,
      onSubmit: async (data) => {
        // Estetään tallennus jo selaimessa, jos mainos ei mahdu mihinkään mahdolliseen paikkaan.
        // Heitetty virhe näytetään lomakkeella (UI.openForm), eikä lomake sulkeudu.
        const fit = fitReport(data.width, data.height, data.campaign_id);
        if (!fit.ok) throw new Error('Mainos on liian suuri kaikkiin mahdollisiin mainospaikkoihin.');
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

  /** Esikatseluikkuna: kuva linkkinä kohde-URL:iin, tiedot ja sopivuus mainospaikkoihin. */
  const openPreview = (c) => {
    const w = c.width; const h = c.height;
    const fit = fitReport(w, h, c.campaign_id);
    UI.openInfo(c.name, `
      <div class="preview-frame">
        <a href="${UI.esc(c.target_url)}" target="_blank" rel="noopener">
          <img src="${UI.esc(c.image_url)}" alt="${UI.esc(c.alt_text)}">
        </a>
      </div>
      <dl class="detail-list">
        <dt>Kampanja</dt><dd>${c.campaign_id ? UI.esc(c.campaign_name) : 'Ei kampanjaa'}</dd>
        <dt>Kohde-URL</dt><dd><a href="${UI.esc(c.target_url)}" target="_blank" rel="noopener">${UI.esc(c.target_url)}</a></dd>
        <dt>ALT-teksti</dt><dd>${UI.esc(c.alt_text || '–')}</dd>
        <dt>Koko</dt><dd>${w && h ? `${w} × ${h} px` : '–'}</dd>
        <dt>Näyttöpaino</dt><dd>${c.weight}</dd>
        <dt>Mainospaikat</dt><dd class="fit-panel">${fit.html}</dd>
      </dl>`);
  };

  // Event delegation: kortit piirretään uudelleen joka latauksessa, joten kuunnellaan ruudukkoa.
  grid.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    const prev = e.target.closest('[data-preview]');
    if (edit) openEditor(creatives.find((c) => c.id === Number(edit.dataset.edit)));
    if (prev) openPreview(creatives.find((c) => c.id === Number(prev.dataset.preview)));
  });
  filter.addEventListener('change', loadCreatives);
  document.getElementById('new-creative').addEventListener('click', () => openEditor(null));

  // Ensin valintalistat (suodatin pitää asettaa ennen hakua), sitten mainokset.
  // finally: mainokset ladataan, vaikka valintalistojen haku epäonnistuisi.
  loadLookups()
    .catch((err) => UI.toast(err.message, 'error'))
    .finally(loadCreatives);
})();
