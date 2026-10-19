/* Kampanjat-sivu (campaigns.html): listaus suodattimilla, luonti/muokkaus, aktivointi ja pysäytys.

   Käyttäjä (admin ja editor) voi:
   - hakea kampanjoita nimellä, tilalla ja mainostajalla (suodatus tehdään palvelimella)
   - luoda, muokata ja poistaa kampanjoita ja valita niille mainospaikat
   - aktivoida tai pysäyttää kampanjan suoraan riviltä
   Tällä sivulla ei ole vain adminille rajattuja toimintoja.

   API:
   - GET    /api/campaigns?q=&status=&advertiser_id=   lista (sis. display_status, placements,
                                                       creative_count, unfit_creative_count)
   - POST   /api/campaigns              uusi kampanja
   - PUT    /api/campaigns/{id}         päivitys (myös mainospaikat: placement_ids)
   - PATCH  /api/campaigns/{id}/status  pelkkä tilan vaihto (Aktivoi / Pysäytä)
   - DELETE /api/campaigns/{id}         poisto (mainokset jäävät talteen ilman kampanjaa)
   - GET    /api/advertisers, /api/placements   valintalistoja varten

   Tila: tietokantaan tallennetaan status (draft/active/paused/archived). Näytettävä tila
   display_status lasketaan näkymässä v_campaign_status: aktiivinen kampanja, jonka alku on
   tulevaisuudessa, on 'pending' ja jonka loppu on mennyt, on 'ended'. */
(() => {
  const tbody = document.getElementById('campaigns-body');
  const countEl = document.getElementById('campaigns-count');
  const search = document.getElementById('campaign-search');
  const statusFilter = document.getElementById('campaign-status-filter');
  const advertiserFilter = document.getElementById('campaign-advertiser-filter');
  const COLS = 7;

  let campaigns = [];
  let advertisers = []; // lomakkeen ja suodattimen valintalistoja varten
  let placements = [];

  // Funktio eikä vakio: valintalistat rakennetaan vasta kun advertisers/placements on haettu.
  const fields = () => [
    { name: 'name', label: 'Kampanjan nimi', required: true, maxlength: 150, wide: true,
      placeholder: 'SaaShop Pipedrive Q4' },
    { name: 'advertiser_id', label: 'Mainostaja', type: 'select', required: true, numeric: true,
      options: [{ value: '', label: '– Valitse –' },
        ...advertisers.map((a) => ({ value: a.id, label: a.name }))] },
    { name: 'status', label: 'Tila', type: 'select', required: true,
      options: [
        { value: 'draft', label: 'Luonnos' },
        { value: 'active', label: 'Aktiivinen' },
        { value: 'paused', label: 'Keskeytetty' },
        { value: 'archived', label: 'Arkistoitu' },
      ],
      help: 'Aktiivinen kampanja näkyy vain aloitus- ja päättymispäivän välillä.' },
    { name: 'start_date', label: 'Aloituspäivä', type: 'date' },
    { name: 'end_date', label: 'Päättymispäivä', type: 'date' },
    { name: 'placement_ids', label: 'Mainospaikat', type: 'checkboxes',
      options: placements.map((p) => ({
        value: p.id,
        label: `${p.name}${p.status === 'inactive' ? ' (ei aktiivinen)' : ''}`,
      })) },
    { name: 'priority', label: 'Prioriteetti (0–100)', type: 'number', min: 0, max: 100,
      emptyValue: 0, help: 'Korkeampi prioriteetti ohittaa muut samaan paikkaan osuvat kampanjat. Yleensä 0.' },
    { name: 'utm_campaign', label: 'UTM-kampanjatunniste', pattern: '[a-z0-9_\\-]+',
      placeholder: 'saashop_pipedrive', help: 'Näkyy mainostajan analytiikassa (utm_campaign).' },
  ];

  /**
   * Lomakkeen data -> API:n muoto (päivät aikaleimoiksi).
   * Lomakkeessa on pelkät päivät, API odottaa aikaleimoja: alku klo 00:00 ja
   * loppu klo 23:59:59, jotta päättymispäivä on vielä kokonaan mukana.
   */
  const toPayload = (data) => {
    const { start_date, end_date, ...rest } = data;
    return {
      ...rest,
      start_time: UI.dateInputToIso(start_date),
      end_time: UI.dateInputToIso(end_date, true),
    };
  };

  /** API:n kampanja -> lomakkeen arvot (toPayloadin vastakohta). */
  const toFormValues = (c) => ({
    ...c,
    start_date: UI.isoToDateInput(c.start_time),
    end_date: UI.isoToDateInput(c.end_time),
    placement_ids: c.placements.map((p) => p.id),
  });

  /**
   * Nopeat tilatoiminnot rivillä.
   * Painike valitaan näytettävän tilan (display_status) mukaan:
   * - active / pending -> "Pysäytä" (status = paused)
   * - paused / draft   -> "Aktivoi" (status = active). Palvelin hylkää aktivoinnin, jos
   *   alku- tai loppupäivä puuttuu (CHECK-rajoite), virhe näytetään toastina.
   */
  const quickAction = (c) => {
    if (c.display_status === 'active' || c.display_status === 'pending')
      return `<button class="btn-ghost" data-status="paused" data-id="${c.id}">Pysäytä</button>`;
    if (c.display_status === 'paused' || c.display_status === 'draft')
      return `<button class="btn-ghost" data-status="active" data-id="${c.id}">Aktivoi</button>`;
    return ''; // päättynyt / arkistoitu: muokataan lomakkeella
  };

  /**
   * Piirtää kampanjataulukon. Varoitus "ei mahdu mainospaikkoihin" (unfit_creative_count)
   * tulee palvelimelta: tällaisia mainoksia ei näytetä missään, joten käyttäjän on hyvä tietää.
   */
  const render = () => {
    countEl.textContent = `Kampanjat (${campaigns.length})`;
    if (!campaigns.length) {
      UI.tableMessage(tbody, COLS, 'Ei hakuehtoja vastaavia kampanjoita.');
      return;
    }
    tbody.innerHTML = campaigns.map((c) => `
      <tr>
        <td>
          ${UI.esc(c.name)}
          <a class="cell-sub" href="creatives.html?campaign_id=${c.id}">${c.creative_count} mainosta →</a>
          ${c.unfit_creative_count ? `<span class="cell-sub cell-warn" title="Mainos on suurempi kuin yksikään kampanjan mainospaikka, joten sitä ei näytetä.">⚠ ${c.unfit_creative_count} ei mahdu mainospaikkoihin</span>` : ''}
        </td>
        <td class="cell-muted">${UI.esc(c.advertiser_name)}</td>
        <td class="cell-muted">${c.placements.map((p) => UI.esc(p.name)).join(', ') || '–'}</td>
        <td>${UI.pill(c.display_status)}</td>
        <td class="cell-muted">${UI.fmtDate(c.start_time)}</td>
        <td class="cell-muted">${UI.fmtDate(c.end_time)}</td>
        <td class="cell-actions">
          ${quickAction(c)}
          <button class="btn-ghost" data-edit="${c.id}">Muokkaa</button>
        </td>
      </tr>`).join('');
  };

  /** Hakee kampanjat suodattimien mukaan (tyhjät arvot jätetään pois kyselystä, ks. Api.get). */
  const load = async () => {
    UI.tableMessage(tbody, COLS, 'Ladataan…');
    try {
      campaigns = await Api.get('/api/campaigns', {
        q: search.value.trim(),
        status: statusFilter.value,
        advertiser_id: advertiserFilter.value,
      });
      render();
    } catch (err) {
      UI.tableMessage(tbody, COLS, err.message, true);
    }
  };

  /** Hakee mainostajat ja mainospaikat rinnakkain ja täyttää mainostajasuodattimen. */
  const loadLookups = async () => {
    [advertisers, placements] = await Promise.all([
      Api.get('/api/advertisers'),
      Api.get('/api/placements'),
    ]);
    advertiserFilter.innerHTML = '<option value="">Kaikki mainostajat</option>' +
      advertisers.map((a) => `<option value="${a.id}">${UI.esc(a.name)}</option>`).join('');
    // Mainostajat-sivun linkki: campaigns.html?advertiser_id=3
    const fromUrl = new URLSearchParams(window.location.search).get('advertiser_id');
    if (fromUrl) advertiserFilter.value = fromUrl;
  };

  /**
   * Avaa luonti-/muokkauslomakkeen. campaign = null -> uusi kampanja.
   * Uusi kampanja alkaa luonnoksena, jotta sen voi tallentaa ilman päivämääriä.
   */
  const openEditor = (campaign) => {
    const isNew = !campaign;
    UI.openForm({
      title: isNew ? 'Uusi kampanja' : `Muokkaa: ${campaign.name}`,
      fields: fields(),
      values: campaign ? toFormValues(campaign) : { status: 'draft', priority: 0, placement_ids: [] },
      submitLabel: isNew ? 'Luo kampanja' : 'Tallenna',
      onSubmit: async (data) => {
        const payload = toPayload(data);
        if (isNew) await Api.post('/api/campaigns', payload);
        else await Api.put(`/api/campaigns/${campaign.id}`, payload);
        UI.toast(isNew ? 'Kampanja luotu.' : 'Muutokset tallennettu.');
        load();
      },
      onDelete: isNew ? null : async () => {
        await Api.del(`/api/campaigns/${campaign.id}`);
        UI.toast('Kampanja poistettu.');
        load();
      },
    });
  };

  /**
   * Vaihtaa kampanjan tilan PATCH-kutsulla. Erillinen kevyt endpoint, jotta
   * koko kampanjaa (nimi, päivät, mainospaikat) ei tarvitse lähettää uudelleen.
   */
  const setStatus = async (id, status) => {
    try {
      await Api.patch(`/api/campaigns/${id}/status`, { status });
      UI.toast(status === 'active' ? 'Kampanja aktivoitu.' : 'Kampanja keskeytetty.');
      load();
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  };

  // Event delegation: rivit piirretään uudelleen joka latauksessa, joten kuunnellaan tbodya.
  tbody.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    const status = e.target.closest('[data-status]');
    if (edit) openEditor(campaigns.find((c) => c.id === Number(edit.dataset.edit)));
    if (status) setStatus(Number(status.dataset.id), status.dataset.status);
  });

  // Haku tehdään palvelimella, joten odotetaan 300 ms kirjoittamisen loppumista (debounce),
  // ettei jokainen näppäily lähetä omaa pyyntöä.
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 300);
  });
  statusFilter.addEventListener('change', load);
  advertiserFilter.addEventListener('change', load);
  document.getElementById('new-campaign').addEventListener('click', () => openEditor(null));

  // Etusivun "Luo uusi kampanja" -painike ohjaa tänne osoitteella campaigns.html#new
  // Valintalistat haetaan ensin, koska suodatin ja lomake tarvitsevat ne. finally: kampanjat
  // ladataan silti, vaikka valintalistojen haku epäonnistuisi. replaceState poistaa #new:n,
  // ettei lomake aukea uudelleen sivun päivityksessä.
  loadLookups()
    .catch((err) => UI.toast(err.message, 'error'))
    .finally(() => {
      load();
      if (window.location.hash === '#new') {
        history.replaceState(null, '', window.location.pathname);
        openEditor(null);
      }
    });
})();
