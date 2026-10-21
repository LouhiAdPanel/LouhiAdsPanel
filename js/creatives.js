/* Mainokset-sivu (creatives.html): korttiruudukko, suodatus, luonti, muokkaus, esikatselu.
   Toteutettu wireframejen "Mainokset", "Suodata", "Uusi mainos", "Muokkaa mainosta",
   "Esikatselu" ja "Poista mainos" mukaan.

   - Mainos kuuluu mainostajalle. Kampanja on valinnainen.
   - Mainos näytetään sijoitusten (placings) kautta: lomakkeella valitaan mainospaikat
     (vähintään yksi), ja jokaisesta paikasta tehdään sijoitus samoilla asetuksilla:
     kampanja, paino, prioriteetti ja aikataulu.
   - Kuvan koko voi poiketa mainospaikan koosta: kuva skaalataan näytettäessä paikan
     kokoon mittasuhteet säilyttäen (louhi-ads.js). Jos mittasuhteet eroavat paljon,
     paikan kohdalla näytetään varoitus (reunoille jää tyhjää), mutta valinta sallitaan.
   - Jos mainos liitetään kampanjaan, valittavissa ovat vain kampanjan mainospaikat
     (Kampanjat-sivulla valitut sallitut paikat). Palvelin tarkistaa saman.

   Käyttäjä (admin ja editor) voi:
   - selata mainoksia kortteina ja suodattaa niitä tilan ja kampanjan mukaan (Suodata-ikkuna)
   - esikatsella mainoksen kuvaa kortin Esikatselu-painikkeella
   - lisätä ja muokata mainosta: lomakkeen "Esikatsele" näyttää mainoksen ennen tallennusta,
     ja esikatselussa valitaan Hylkää / Palaa takaisin muokkaamaan / Hyväksy
   - poistaa mainoksen muokkauslomakkeelta (vahvistuskysymyksen jälkeen)
   Tällä sivulla ei ole vain adminille rajattuja toimintoja.

   API:
   - GET    /api/creatives?campaign_id=  tai  ?unassigned=true   lista
   - POST   /api/creatives/upload        kuvan lataus (palauttaa url, width, height)
   - POST   /api/creatives               uusi mainos ja sen sijoitukset
   - PUT    /api/creatives/{id}          päivitys
   - DELETE /api/creatives/{id}          poisto
   - GET    /api/advertisers, /api/campaigns, /api/placements   valintalistat

   Sivulle voi tulla linkillä creatives.html?campaign_id=5 (Kampanjat-sivulta),
   jolloin kampanjasuodatin on valmiiksi päällä. */
(() => {
  const grid = document.getElementById('creatives-grid');
  const countEl = document.getElementById('creatives-count');
  const filterBtn = document.getElementById('creatives-filter');
  let creatives = [];
  let advertisers = [];
  let campaigns = [];
  let placements = [];

  // Mainosten tilat sivun omilla teksteillä (wireframe: "Tauolla").
  const STATUS_LABELS = { active: 'Aktiivinen', paused: 'Tauolla', inactive: 'Ei aktiivinen' };
  const statusPill = (status) => UI.pill(status, { paused: 'Tauolla' });

  // Prioriteetin tasot kuten kampanjoissa: tallennetaan lukuna 0–100, suurempi voittaa.
  const PRIORITIES = [
    { value: 0, label: 'Matala' },
    { value: 50, label: 'Normaali' },
    { value: 100, label: 'Korkea' },
  ];
  /** Vanha vapaa luku (esim. 10) -> lähin taso, jotta valikossa näkyy aina jokin valinta. */
  const priorityLevel = (v) => (v >= 75 ? 100 : v >= 25 ? 50 : 0);

  /* ---------- Suodatus ----------
     Suodattimet ovat Suodata-ikkunassa. Kampanjasuodatus tehdään palvelimella
     (campaign_id / unassigned), tilasuodatus selaimessa haetusta listasta. */

  // Kampanjasuodattimen erikoisarvo "Ilman kampanjaa". Tyhjä arvo tarkoittaa "kaikki",
  // joten kampanjattomille tarvitaan oma arvo; se muutetaan API:lle muotoon unassigned=true.
  const NO_CAMPAIGN = 'none';
  const filters = {
    status: '',
    campaign: new URLSearchParams(window.location.search).get('campaign_id') || '',
  };
  const isFiltered = () => Boolean(filters.status || filters.campaign);

  /** Suodata-painike: teksti "Suodatettu" ja korostus, kun jokin suodatin on päällä. */
  const updateFilterButton = () => {
    filterBtn.textContent = isFiltered() ? 'Suodatettu' : 'Suodata';
    filterBtn.classList.toggle('is-filtered', isFiltered());
  };

  /** Valintalistan <option>-rivit; selected-arvo merkitään valituksi. */
  const optionsHtml = (options, selected) => options.map((o) =>
    `<option value="${UI.esc(o.value)}"${String(o.value) === String(selected) ? ' selected' : ''}>${UI.esc(o.label)}</option>`).join('');

  /**
   * Avaa Suodata-ikkunan (wireframe: Status + painikkeet Peruuta / Poista suodattimet / Hyväksy).
   * Lisäksi kampanjavalinta, jotta Kampanjat-sivun "N mainosta →" -linkki toimii edelleen.
   */
  const openFilterDialog = async () => {
    let chosen = null; // ikkunan kenttien arvot luetaan onDone-kutsussa ennen ikkunan poistoa
    const action = await UI.choiceDialog({
      title: 'Suodata',
      html: `
        <div class="form-grid">
          <div class="field field-wide"><label for="filter-status">Status</label>
            <select class="select" id="filter-status" name="status">${optionsHtml([
              { value: '', label: 'Kaikki' },
              ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
            ], filters.status)}</select>
          </div>
          <div class="field field-wide"><label for="filter-campaign">Kampanja</label>
            <select class="select" id="filter-campaign" name="campaign">${optionsHtml([
              { value: '', label: 'Kaikki' },
              { value: NO_CAMPAIGN, label: 'Ilman kampanjaa' },
              ...campaigns.map((c) => ({ value: c.id, label: c.name })),
            ], filters.campaign)}</select>
          </div>
        </div>`,
      buttons: [
        { value: 'cancel', label: 'Peruuta' },
        { value: 'clear', label: 'Poista suodattimet' },
        { value: 'apply', label: 'Hyväksy', cls: 'btn-primary' },
      ],
      onDone: (value, dialog) => {
        chosen = {
          status: dialog.querySelector('[name="status"]').value,
          campaign: dialog.querySelector('[name="campaign"]').value,
        };
      },
    });
    if (action === 'apply') Object.assign(filters, chosen);
    else if (action === 'clear') Object.assign(filters, { status: '', campaign: '' });
    else return; // Peruuta, × tai Esc: suodattimet ennallaan
    updateFilterButton();
    loadCreatives();
  };

  /* ---------- Mainospaikkojen valinta ----------
     Paikka on valittavissa, jos se on aktiivinen ja, kun kampanja on valittu, kuuluu
     kampanjan mainospaikkoihin. Palvelin tekee samat tarkistukset (creatives.py, _prepare);
     tämä on käyttäjälle välitön palaute jo lomakkeella. Kuvan koko ei estä valintaa. */

  /**
   * Poikkeavatko w × h -kuvan ja mainospaikan p mittasuhteet selvästi (yli 25 %)?
   * Silloin skaalattuun mainokseen jää reunoille tyhjää tilaa.
   */
  const ratioDiffers = (w, h, p) => {
    const r = (w / h) / (p.width / p.height);
    return r > 1.25 || r < 1 / 1.25;
  };

  /** Kampanjan sallittujen mainospaikkojen id:t (Set) tai null, jos kampanjaa ei ole valittu. */
  const campaignPlacementIds = (campaignId) => {
    const c = campaigns.find((x) => x.id === Number(campaignId));
    return c ? new Set(c.placements.map((p) => p.id)) : null;
  };

  /**
   * Päivittää mainospaikkavalinnan lomakkeen nykyisillä arvoilla (mitat ja kampanja).
   * Sopimattomat paikat poistetaan käytöstä ja niiden ruksi poistetaan, jotta lomake ei
   * lähetä paikkoja, joissa mainosta ei voisi näyttää. Syy näytetään paikan nimen alla.
   * Valittavissa olevien paikkojen kohdalla näytetään huomautus, jos kuvan mittasuhde
   * poikkeaa paikasta (kuva skaalataan, reunoille jää tyhjää).
   */
  const updatePlacementPicker = (form) => {
    const w = Number(form.elements.width.value) || 0;
    const h = Number(form.elements.height.value) || 0;
    const allowed = campaignPlacementIds(form.elements.campaign_id.value);
    form.querySelectorAll('input[name="placement_ids"]').forEach((input) => {
      const p = placements.find((x) => x.id === Number(input.value));
      const label = input.closest('.check');
      let reason = '';
      if (allowed && !allowed.has(p.id)) reason = 'ei kampanjan paikka';
      else if (p.status !== 'active' && !input.checked) reason = 'ei aktiivinen';
      const warn = !reason && w && h && ratioDiffers(w, h, p)
        ? 'mittasuhde poikkeaa, reunoille jää tyhjää' : '';
      input.disabled = Boolean(reason);
      if (reason) input.checked = false;
      label.classList.toggle('is-disabled', Boolean(reason));
      let note = label.querySelector('.check-note');
      if (!note) {
        note = document.createElement('small');
        note.className = 'check-note';
        label.append(note);
      }
      note.textContent = reason || warn ? ` – ${reason || warn}` : '';
      note.classList.toggle('is-warn', Boolean(warn));
    });
  };

  /* ---------- Lomake ---------- */

  /** Kampanjavalinnan vaihtoehdot: valitun mainostajan kampanjat (kampanja on valinnainen). */
  const campaignOptions = (advertiserId) => [
    { value: '', label: '– Ei kampanjaa –' },
    ...campaigns
      .filter((c) => !advertiserId || c.advertiser_id === Number(advertiserId))
      .map((c) => ({ value: c.id, label: c.name })),
  ];

  // Funktio eikä vakio: valintalistat ovat käytettävissä vasta loadLookupsin jälkeen.
  // Kentät jakautuvat kahteen osaan: mainoksen tiedot (mainostaja, nimi, kuva, linkki)
  // ja sijoitusten yhteiset asetukset (kampanja, mainospaikat, paino, prioriteetti, aikataulu).
  const fields = (advertiserId) => [
    { name: 'name', label: 'Mainoksen nimi', required: true, maxlength: 150, placeholder: 'Banneri A' },
    { name: 'advertiser_id', label: 'Mainostaja', type: 'select', numeric: true, required: true,
      options: [{ value: '', label: '– Valitse –' },
        ...advertisers.map((a) => ({ value: a.id, label: a.name }))] },
    { name: 'campaign_id', label: 'Kampanja', type: 'select', numeric: true,
      tooltip: 'Valinnainen. Kampanjan tila ja aikataulu rajaavat silloin näkymistä, ja mainoksen '
        + 'voi sijoittaa vain kampanjan mainospaikkoihin.',
      options: campaignOptions(advertiserId) },
    { name: 'status', label: 'Status', type: 'select', required: true,
      options: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })) },
    { name: 'image_url', label: 'Mainoskuva', type: 'image', required: true, wide: true,
      help: 'Lataa JPG tai PNG (enintään 5 Mt) tai anna mainoskuvan URL.',
      upload: (file) => Api.upload('/api/creatives/upload', file),
      onUploaded: (img, form) => {
        form.elements.width.value = img.width;
        form.elements.height.value = img.height;
        updatePlacementPicker(form);
      } },
    { name: 'width', label: 'Leveys (px)', type: 'number', readonly: true, help: 'Luetaan kuvasta.' },
    { name: 'height', label: 'Korkeus (px)', type: 'number', readonly: true, help: 'Luetaan kuvasta.' },
    { name: 'target_url', label: 'Target URL', type: 'url', required: true, wide: true,
      placeholder: 'https://www.saashop.fi/',
      tooltip: 'Sivu, jolle mainoksen klikkaus vie. UTM-parametrit lisätään klikatessa automaattisesti.' },
    // Vaihtoehdoiksi kaikki mainospaikat; updatePlacementPicker poistaa käytöstä sopimattomat.
    { name: 'placement_ids', label: 'Mainospaikat *', type: 'checkboxes',
      tooltip: 'Valitse vähintään yksi. Jokaisesta paikasta tulee sijoitus. Kuva skaalataan '
        + 'näytettäessä mainospaikan kokoon.',
      options: placements.map((p) => ({ value: p.id, label: `${p.name} (${p.width} × ${p.height})` })) },
    // Painoarvo vain kampanjattomalle mainokselle (updateWeightField lukitsee kentän,
    // kun kampanja on valittu). Kampanjan mainokset jaetaan tasan.
    { name: 'weight', label: 'Paino (0–100)', type: 'number', required: true, min: 0, max: 100,
      help: 'Vain mainokselle, joka ei kuulu kampanjaan.',
      tooltip: 'Suhteellinen osuus näytöistä samassa paikassa saman prioriteetin mainosten kesken. '
        + '0 = ei näytetä. Kampanjan mainoksilla ei ole painoarvoa: ne näytetään tasaisesti vuorotellen.' },
    { name: 'priority', label: 'Prioriteetti', type: 'select', numeric: true, required: true,
      tooltip: 'Kun samaan mainospaikkaan osuu useita mainoksia, korkeamman prioriteetin mainos näytetään ensin.',
      options: PRIORITIES.map((p) => ({ value: p.value, label: p.label })) },
    { name: 'start_date', label: 'Näkyy alkaen', type: 'date', help: 'Tyhjä = heti.' },
    { name: 'end_date', label: 'Näkyy asti', type: 'date', help: 'Tyhjä = toistaiseksi.' },
    { name: 'alt_text', label: 'ALT-teksti', maxlength: 200, wide: true, emptyValue: '',
      placeholder: 'Lyhyt kuvaus mainoksesta (saavutettavuus)' },
  ];

  /** Täyttää kampanjavalinnan valitun mainostajan kampanjoilla (valinta säilyy, jos mahdollista). */
  const updateCampaignSelect = (form) => {
    const select = form.elements.campaign_id;
    const current = select.value;
    const options = campaignOptions(form.elements.advertiser_id.value);
    select.innerHTML = optionsHtml(options, current);
    select.value = options.some((o) => String(o.value) === current) ? current : '';
  };

  /** Lomakkeen yläosan tunnisteet (wireframe): Mainoksen numero ja Mainostajan numero. */
  const idsHtml = (creative, advertiserId) => `
    <div class="form-ids">
      <span class="form-id">Mainoksen numero <strong>${creative ? `#${creative.id}` : 'uusi'}</strong></span>
      <span class="form-id">Mainostajan numero <strong data-advertiser-no>${advertiserId ? `#${advertiserId}` : '–'}</strong></span>
    </div>`;

  /**
   * UI.openForm kutsuu tätä (onRender), kun lomake on piirretty.
   * - Mainostajan vaihto rajaa kampanjavalinnan ja päivittää mainostajan numeron.
   * - Kampanjan valinta ehdottaa kampanjan prioriteettia ja rajaa mainospaikat.
   */
  /**
   * Painoarvo on vain kampanjattomalla mainoksella. Kun kampanja valitaan, Paino-kenttä
   * lukitaan ja tyhjennetään (disabled-kenttää ei myöskään vaadita); kun kampanja
   * poistetaan, aiempi arvo palautetaan (tai oletus 1).
   */
  const updateWeightField = (form) => {
    const input = form.elements.weight;
    const inCampaign = Boolean(form.elements.campaign_id.value);
    if (inCampaign && !input.disabled) input.dataset.saved = input.value;
    if (!inCampaign && input.disabled) input.value = input.dataset.saved || 1;
    if (inCampaign) input.value = '';
    input.disabled = inCampaign;
    input.placeholder = inCampaign ? 'Ei painoarvoa (kampanjan mainos)' : '';
    input.closest('.field').classList.toggle('is-disabled', inCampaign);
  };

  const attachFormLogic = (form) => {
    const advNo = form.closest('dialog').querySelector('[data-advertiser-no]');
    form.elements.advertiser_id.addEventListener('change', () => {
      const id = form.elements.advertiser_id.value;
      advNo.textContent = id ? `#${id}` : '–';
      updateCampaignSelect(form);
      updatePlacementPicker(form);
    });
    form.elements.campaign_id.addEventListener('change', () => {
      const c = campaigns.find((x) => x.id === Number(form.elements.campaign_id.value));
      if (c) form.elements.priority.value = priorityLevel(c.priority);
      updatePlacementPicker(form);
      updateWeightField(form);
    });
    // URL:lla annetun kuvan mitat luetaan myös (ui.js kutsuu onUploaded); varmistus tähän
    form.elements.width.addEventListener('change', () => updatePlacementPicker(form));
    updatePlacementPicker(form);
    updateWeightField(form);
  };

  /** Listan mainos -> lomakkeen arvot (sijoitusten paikat ja päivät lomakkeen muotoon). */
  const toFormValues = (c) => ({
    ...c,
    placement_ids: c.placements.map((p) => p.id),
    weight: c.weight ?? 1,
    priority: priorityLevel(c.priority ?? 0),
    start_date: UI.isoToDateInput(c.start_time),
    end_date: UI.isoToDateInput(c.end_time),
  });

  /**
   * Esikatselu ennen tallennusta (wireframe "Esikatselu").
   * Palauttaa 'ok' (Hyväksy), 'discard' (Hylkää) tai 'back' (Palaa takaisin muokkaamaan,
   * myös × ja Esc).
   */
  const previewBeforeSave = async (data) => {
    const chosen = placements.filter((p) => data.placement_ids.includes(p.id));
    const campaign = campaigns.find((c) => c.id === data.campaign_id);
    const value = await UI.choiceDialog({
      title: 'Esikatselu',
      wide: true,
      html: `
        <div class="preview-stage">
          <img src="${UI.esc(data.image_url)}" alt="${UI.esc(data.alt_text)}">
        </div>
        <div class="preview-meta">
          <strong>${UI.esc(data.name)}</strong>
          ${data.width && data.height ? ` · ${data.width} × ${data.height} px` : ''}
          · ${campaign ? UI.esc(campaign.name) : 'ei kampanjaa'}<br>
          Target URL: ${UI.esc(data.target_url)}<br>
          Mainospaikat: ${chosen.map((p) => UI.esc(p.name)).join(', ')}
        </div>`,
      buttons: [
        { value: 'discard', label: 'Hylkää' },
        { value: 'back', label: 'Palaa takaisin muokkaamaan' },
        { value: 'ok', label: 'Hyväksy', cls: 'btn-primary' },
      ],
    });
    return value || 'back';
  };

  /**
   * Avaa "Uusi mainos"- tai "Muokkaa mainosta" -lomakkeen. creative = null -> uusi mainos.
   * Uusi mainos liitetään oletuksena suodattimessa valittuun kampanjaan (jos sellainen on).
   * Lomakkeen pääpainike on "Esikatsele": tallennus tehdään vasta esikatselun Hyväksy-painikkeesta.
   */
  const openEditor = (creative) => {
    const isNew = !creative;
    const camp = campaigns.find((c) => String(c.id) === filters.campaign);
    const values = creative ? toFormValues(creative) : {
      status: 'active', weight: 1, priority: camp ? priorityLevel(camp.priority) : 0, placement_ids: [],
      advertiser_id: camp ? camp.advertiser_id : '', campaign_id: camp ? camp.id : '',
    };
    UI.openForm({
      title: isNew ? 'Uusi mainos' : 'Muokkaa mainosta',
      headerHtml: idsHtml(creative, values.advertiser_id),
      fields: fields(values.advertiser_id),
      values,
      submitLabel: 'Esikatsele',
      busyLabel: 'Esikatselu…',
      onRender: attachFormLogic,
      onSubmit: async (data) => {
        // Mainospaikka on pakollinen. Heitetty virhe näytetään lomakkeella (UI.openForm),
        // eikä lomake sulkeudu. Käytöstä poistetut (sopimattomat) paikat eivät ole valittuina.
        if (!data.placement_ids.length) throw new Error('Valitse vähintään yksi mainospaikka.');

        const choice = await previewBeforeSave(data);
        if (choice === 'back') return false;  // lomake jää auki, tiedot säilyvät
        if (choice === 'discard') return;     // lomake suljetaan tallentamatta

        // Hyväksy: päivät -> aikaleimat (alku klo 00:00, loppu klo 23:59:59) ja tallennus
        const { start_date, end_date, ...rest } = data;
        const body = {
          ...rest,
          // Kampanjan mainoksella ei ole painoarvoa: lähetetään neutraali 1 (palvelin tekee saman)
          weight: rest.campaign_id ? 1 : rest.weight,
          start_time: UI.dateInputToIso(start_date),
          end_time: UI.dateInputToIso(end_date, true),
        };
        if (isNew) await Api.post('/api/creatives', body);
        else await Api.put(`/api/creatives/${creative.id}`, body);
        UI.toast(isNew ? 'Mainos lisätty.' : 'Mainos päivitetty.');
        loadCreatives();
      },
      deleteLabel: 'Poista mainos',
      deleteConfirm: 'Haluatko varmasti poistaa mainoksen?',
      deleteConfirmLabel: 'Kyllä',
      onDelete: isNew ? null : async () => {
        await Api.del(`/api/creatives/${creative.id}`);
        UI.toast('Mainos poistettu.');
        loadCreatives();
      },
    });
  };

  /** Kortin Esikatselu: pelkkä mainoskuva (linkkinä kohdesivulle) isona. */
  const openPreview = (c) => {
    UI.openInfo(c.name, `
      <div class="preview-stage">
        <a href="${UI.esc(c.target_url)}" target="_blank" rel="noopener">
          <img src="${UI.esc(c.image_url)}" alt="${UI.esc(c.alt_text)}">
        </a>
      </div>
      <div class="preview-meta">${c.width && c.height ? `${c.width} × ${c.height} px · ` : ''}${
        c.placements.length ? `Mainospaikat: ${c.placements.map((p) => UI.esc(p.name)).join(', ')}`
          : 'Ei mainospaikkoja'}</div>`);
  };

  /* ---------- Listaus ---------- */

  /** Kortin pikkukuva; jos kuvaa ei ole, näytetään pelkät mitat. */
  const thumb = (c) => c.image_url
    ? `<img src="${UI.esc(c.image_url)}" alt="${UI.esc(c.alt_text)}" loading="lazy">`
    : `${c.width || '?'} × ${c.height || '?'}`;

  /** Piirtää mainoskortit (wireframe: kuva, Mainos #, nimi, Target URL, paino, status). */
  const render = () => {
    const shown = filters.status ? creatives.filter((c) => c.status === filters.status) : creatives;
    countEl.textContent = `Mainokset (${shown.length})`;
    if (!shown.length) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <span class="plus-badge">+</span>
          <span>${isFiltered() ? 'Ei suodattimia vastaavia mainoksia.' : 'Ei mainoksia.'}
            Lisää mainos yläkulman painikkeesta.</span>
        </div>`;
      return;
    }
    grid.innerHTML = shown.map((c) => `
      <div class="creative-card">
        <div class="creative-thumb">${thumb(c)}</div>
        <div class="creative-body">
          <p class="creative-number">Mainos #${c.id}</p>
          <h3>${UI.esc(c.name)}</h3>
          <p class="creative-meta">${UI.esc(c.advertiser_name)} · ${c.campaign_id
            ? UI.esc(c.campaign_name) : 'ei kampanjaa'}</p>
          <p class="creative-meta">Target URL:
            <a class="creative-url" href="${UI.esc(c.target_url)}" target="_blank" rel="noopener">${UI.esc(c.target_url)}</a></p>
          <p class="creative-meta">${c.placements.length
            ? `${c.campaign_id ? '' : `Paino ${c.weight} · `}${c.placements.map((p) => UI.esc(p.name)).join(', ')}`
            : '<span class="no-campaign">Ei mainospaikkoja – valitse muokkaamalla</span>'}</p>
          <div class="creative-footer">
            ${statusPill(c.status)}
            <span>
              <button class="btn btn-small" data-preview="${c.id}">Esikatselu</button>
              <button class="btn btn-small" data-edit="${c.id}">Muokkaa</button>
            </span>
          </div>
        </div>
      </div>`).join('');
  };

  /** Hakee mainokset kampanjasuodattimen mukaan ja piirtää ruudukon. */
  const loadCreatives = async () => {
    grid.innerHTML = '<p class="table-message">Ladataan…</p>';
    try {
      // NO_CAMPAIGN -> unassigned=true (vain kampanjattomat). Muuten campaign_id; tyhjä arvo
      // jätetään kyselystä pois (Api.get), jolloin palvelin palauttaa kaikki mainokset.
      const query = filters.campaign === NO_CAMPAIGN ? { unassigned: true } : { campaign_id: filters.campaign };
      creatives = await Api.get('/api/creatives', query);
      render();
    } catch (err) {
      grid.innerHTML = `<p class="table-message is-error">${UI.esc(err.message)}</p>`;
    }
  };

  /** Hakee mainostajat, kampanjat ja mainospaikat rinnakkain (lomake ja suodatin tarvitsevat ne). */
  const loadLookups = async () => {
    [advertisers, campaigns, placements] = await Promise.all([
      Api.get('/api/advertisers'), Api.get('/api/campaigns'), Api.get('/api/placements')]);
  };

  // Event delegation: kortit piirretään uudelleen joka latauksessa, joten kuunnellaan ruudukkoa.
  grid.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    const prev = e.target.closest('[data-preview]');
    if (edit) openEditor(creatives.find((c) => c.id === Number(edit.dataset.edit)));
    if (prev) openPreview(creatives.find((c) => c.id === Number(prev.dataset.preview)));
  });
  filterBtn.addEventListener('click', openFilterDialog);
  document.getElementById('new-creative').addEventListener('click', () => openEditor(null));

  // Ensin valintalistat, sitten mainokset. finally: mainokset ladataan,
  // vaikka valintalistojen haku epäonnistuisi.
  updateFilterButton();
  loadLookups()
    .catch((err) => UI.toast(err.message, 'error'))
    .finally(loadCreatives);
})();
