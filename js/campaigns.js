/* Kampanjat-sivu (campaigns.html): listaus suodattimilla, luonti, muokkaus ja poisto.
   Toteutettu wireframejen "Kampanjat", "Luo uusi kampanja" ja "Muokkaa kampanjaa / Poista
   kampanja" mukaan.

   Käyttäjä (admin ja editor) voi:
   - hakea kampanjoita nimellä, tilalla ja mainostajalla (suodatus tehdään palvelimella)
   - luoda ja muokata kampanjoita: nimi, mainostaja, tila, aloitus- ja päättymispäivä,
     sallitut mainospaikat, prioriteetti (Matala / Normaali / Korkea) ja UTM-tunniste
   - poistaa kampanjan rivin Poista-painikkeella (vahvistuskysymyksen jälkeen)
   Kampanjan mainokset liitetään Mainokset-sivulla (sijoitukset): mainoksen voi sijoittaa
   vain kampanjan sallittuihin mainospaikkoihin.
   Tällä sivulla ei ole vain adminille rajattuja toimintoja.

   API:
   - GET    /api/campaigns?q=&status=&advertiser_id=   lista (sis. display_status, placements,
                                                       creative_count)
   - POST   /api/campaigns              uusi kampanja (sis. placement_ids)
   - PUT    /api/campaigns/{id}         päivitys (sis. placement_ids)
   - DELETE /api/campaigns/{id}         poisto (mainokset jäävät talteen; kampanjan sijoitukset
                                         irrotetaan ja merkitään ei-aktiivisiksi)
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
  const COLS = 6;

  let campaigns = [];
  let advertisers = []; // lomakkeen ja suodattimen valintalistoja varten
  let placements = [];  // lomakkeen mainospaikkavalintaa varten

  // Prioriteetin tasot (wireframe: pudotusvalikko). Tallennetaan lukuna 0–100,
  // jotta jakelu voi verrata prioriteetteja; suurempi voittaa samassa paikassa.
  const PRIORITIES = [
    { value: 0, label: 'Matala' },
    { value: 50, label: 'Normaali' },
    { value: 100, label: 'Korkea' },
  ];
  /** Vanha vapaa luku (esim. 10) -> lähin taso, jotta valikossa näkyy aina jokin valinta. */
  const priorityLevel = (v) => (v >= 75 ? 100 : v >= 25 ? 50 : 0);

  // Funktio eikä vakio: valintalistat ovat käytettävissä vasta loadLookupsin jälkeen.
  // Kenttien järjestys ja ?-ohjeet (tooltip) wireframen mukaan.
  const fields = () => [
    { name: 'name', label: 'Kampanjan nimi', required: true, maxlength: 150, wide: true,
      placeholder: 'Syyskampanja 2026' },
    { name: 'advertiser_id', label: 'Mainostaja', type: 'select', required: true, numeric: true, wide: true,
      options: [{ value: '', label: '– Valitse –' },
        ...advertisers.map((a) => ({ value: a.id, label: a.name }))] },
    { name: 'status', label: 'Tila', type: 'select', required: true, wide: true,
      tooltip: 'Aktiivinen kampanja näkyy vain aloitus- ja päättymispäivän välillä. Luonnos ja '
        + 'keskeytetty eivät näy. Aktiivisella kampanjalla on oltava molemmat päivät.',
      options: [
        { value: 'active', label: 'Aktiivinen' },
        { value: 'draft', label: 'Luonnos' },
        { value: 'paused', label: 'Keskeytetty' },
        { value: 'archived', label: 'Arkistoitu' },
      ] },
    { name: 'start_date', label: 'Aloituspäivä', type: 'date' },
    { name: 'end_date', label: 'Päättymispäivä', type: 'date' },
    { name: 'placement_ids', label: 'Mainospaikat', type: 'multiselect', placeholder: 'Valitse mainospaikat',
      tooltip: 'Paikat, joissa kampanjan mainokset saavat näkyä. Mainosta lisättäessä kampanjan '
        + 'mainokselle voi valita vain näitä paikkoja.',
      options: placements.map((p) => ({
        value: p.id,
        label: `${p.name} (${p.width} × ${p.height})${p.status === 'active' ? '' : ' – ei aktiivinen'}`,
      })) },
    { name: 'priority', label: 'Prioriteetti', type: 'select', numeric: true, wide: true,
      tooltip: 'Kun samaan mainospaikkaan osuu useita mainoksia, korkeamman prioriteetin mainos '
        + 'näytetään ensin. Toimii oletuksena kampanjan mainoksille.',
      options: [{ value: '', label: 'Valitse prioriteetti' },
        ...PRIORITIES.map((p) => ({ value: p.value, label: p.label }))] },
    { name: 'utm_campaign', label: 'UTM-kampanjatunniste', pattern: '[a-z0-9_\\-]+', wide: true,
      placeholder: 'syyskampanja_2026', help: 'Näkyy mainostajan analytiikassa (utm_campaign). Pienet kirjaimet, numerot, _ ja -.' },
  ];

  /**
   * Lomakkeen data -> API:n muoto (päivät aikaleimoiksi).
   * Lomakkeessa on pelkät päivät, API odottaa aikaleimoja: alku klo 00:00 ja
   * loppu klo 23:59:59, jotta päättymispäivä on vielä kokonaan mukana.
   * Valitsematon prioriteetti tallennetaan Matalana (0).
   */
  const toPayload = (data) => {
    const { start_date, end_date, ...rest } = data;
    return {
      ...rest,
      priority: rest.priority ?? 0,
      start_time: UI.dateInputToIso(start_date),
      end_time: UI.dateInputToIso(end_date, true),
    };
  };

  /** API:n kampanja -> lomakkeen arvot (toPayloadin vastakohta). */
  const toFormValues = (c) => ({
    ...c,
    start_date: UI.isoToDateInput(c.start_time),
    end_date: UI.isoToDateInput(c.end_time),
    priority: priorityLevel(c.priority),
    placement_ids: c.placements.map((p) => p.id),
  });

  /** Piirtää kampanjataulukon (wireframen sarakkeet). Nimen alla linkki kampanjan mainoksiin. */
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
        </td>
        <td class="cell-muted">${UI.esc(c.advertiser_name)}</td>
        <td>${UI.pill(c.display_status)}</td>
        <td class="cell-muted">${UI.fmtDate(c.start_time)}</td>
        <td class="cell-muted">${UI.fmtDate(c.end_time)}</td>
        <td class="cell-actions">
          <button class="btn btn-small" data-edit="${c.id}">Muokkaa</button>
          <button class="btn btn-small btn-small-danger" data-delete="${c.id}">Poista</button>
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
    [advertisers, placements] = await Promise.all([Api.get('/api/advertisers'), Api.get('/api/placements')]);
    advertiserFilter.innerHTML = '<option value="">Kaikki mainostajat</option>' +
      advertisers.map((a) => `<option value="${a.id}">${UI.esc(a.name)}</option>`).join('');
    // Mainostajat-sivun linkki: campaigns.html?advertiser_id=3
    const fromUrl = new URLSearchParams(window.location.search).get('advertiser_id');
    if (fromUrl) advertiserFilter.value = fromUrl;
  };

  /**
   * Avaa "Luo uusi kampanja"- tai "Muokkaa kampanjaa" -lomakkeen. campaign = null -> uusi.
   * Uusi kampanja on oletuksena aktiivinen (wireframe); ilman päivämääriä tallennus
   * pyytää ne, tai tilaksi voi valita luonnoksen.
   */
  const openEditor = (campaign) => {
    const isNew = !campaign;
    UI.openForm({
      title: isNew ? 'Luo uusi kampanja' : 'Muokkaa kampanjaa',
      fields: fields(),
      values: campaign ? toFormValues(campaign) : { status: 'active', priority: '', placement_ids: [] },
      submitLabel: isNew ? 'Luo kampanja' : 'Tallenna',
      onSubmit: async (data) => {
        const payload = toPayload(data);
        if (isNew) await Api.post('/api/campaigns', payload);
        else await Api.put(`/api/campaigns/${campaign.id}`, payload);
        UI.toast(isNew ? 'Kampanja luotu.' : 'Kampanjan tiedot päivitetty.');
        load();
      },
    });
  };

  /**
   * Poista-painike: vahvistuskysymys (wireframe "Poista kampanja"), sitten poisto.
   * Kampanjan mainokset ja tilastot säilyvät; mainokset irrotetaan kampanjasta (palvelin).
   */
  const deleteCampaign = async (c) => {
    const ok = await UI.confirm({
      title: 'Poista kampanja',
      message: `Haluatko varmasti poistaa tämän kampanjan? (${c.name})`,
    });
    if (!ok) return;
    try {
      await Api.del(`/api/campaigns/${c.id}`);
      UI.toast('Kampanja poistettu.');
      load();
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  };

  // Event delegation: rivit piirretään uudelleen joka latauksessa, joten kuunnellaan tbodya.
  tbody.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-delete]');
    if (edit) openEditor(campaigns.find((c) => c.id === Number(edit.dataset.edit)));
    if (del) deleteCampaign(campaigns.find((c) => c.id === Number(del.dataset.delete)));
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
