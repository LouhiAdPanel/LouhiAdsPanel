/* Kampanjat-sivu (campaigns.html): listaus suodattimilla, luonti, muokkaus ja poisto.
   Toteutettu wireframejen "Kampanjat", "Luo uusi kampanja" ja "Muokkaa kampanjaa / Poista
   kampanja" mukaan.

   Käyttäjä (admin ja editor) voi:
   - hakea kampanjoita nimellä, tilalla ja mainostajalla (suodatus tehdään palvelimella)
   - luoda ja muokata kampanjoita: nimi, mainostaja, tila, aloitus- ja päättymispäivä,
     sallitut mainospaikat, kampanjan mainokset ja UTM-tunniste
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
  // Sivutus 20 kampanjaa/sivu (UI.pager). Hakuehdon muutos palaa sivulle 1.
  const pager = UI.pager(document.getElementById('campaigns-pager'), () => render());
  const search = document.getElementById('campaign-search');
  const statusFilter = document.getElementById('campaign-status-filter');
  const advertiserFilter = document.getElementById('campaign-advertiser-filter');
  const COLS = 6;

  let campaigns = [];
  let advertisers = []; // lomakkeen ja suodattimen valintalistoja varten
  let placements = [];  // lomakkeen mainospaikkavalintaa varten
  let creatives = [];   // lomakkeen Mainokset-monivalintaa varten (haetaan lomaketta avattaessa)

  /**
   * Mainokset-monivalinnan vaihtoehdot: valitun mainostajan mainokset. Jos mainos on jo
   * toisessa kampanjassa, se kerrotaan (valinta siirtää mainoksen tähän kampanjaan).
   */
  const creativeOptions = (advertiserId, campaignId) => creatives
    .filter((c) => c.advertiser_id === Number(advertiserId))
    .map((c) => ({
      value: c.id,
      label: `${c.name} (#${c.id})${c.campaign_id && c.campaign_id !== campaignId
        ? ` – nyt kampanjassa ${c.campaign_name}` : ''}`,
    }));

  // Kampanjalla ei ole prioriteettia eikä painoarvoa: mainosten näkyvyys määräytyy
  // mainoksen omasta painoarvosta (Mainokset-sivu). Tiimin päätös, ks. migraatio 008.

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
    { name: 'creative_ids', label: 'Mainokset', type: 'multiselect', placeholder: 'Valitse mainokset',
      tooltip: 'Kampanjaan kuuluvat mainokset (valitun mainostajan mainokset). Uusi mainos näytetään '
        + 'kampanjan kaikissa mainospaikoissa. Valinnasta poistettu mainos irrotetaan kampanjasta ja '
        + 'merkitään ei-aktiiviseksi. Mainoksen voi liittää kampanjaan myös Mainokset-sivulla.',
      help: 'Valitse ensin mainostaja ja mainospaikat.',
      options: [] },
    { name: 'utm_campaign', label: 'UTM-kampanjatunniste', pattern: '[a-z0-9_\\-]+', wide: true,
      placeholder: 'syyskampanja_2026', help: 'Näkyy mainostajan analytiikassa (utm_campaign). Pienet kirjaimet, numerot, _ ja -.',
      patternMessage: 'Käytä vain pieniä kirjaimia a–z, numeroita, alaviivaa _ ja viivaa - (ei välilyöntejä tai ääkkösiä).' },
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
    creative_ids: c.creative_ids || [],
  });

  /**
   * Aktiivisella kampanjalla on oltava aloitus- ja päättymispäivä (palvelin vaatii saman).
   * Päiväkenttien otsikoihin tulee pakollisuuden tähti (*) aina, kun tilaksi on valittu
   * Aktiivinen, ja se poistuu muilla tiloilla (testauksen havainto V4: päivät vaadittiin,
   * vaikka tähteä ei ollut). Varsinainen tarkistus on lomakkeen validate-säännössä.
   */
  const attachDateRequirement = (form) => {
    const marks = ['start_date', 'end_date'].map((name) => {
      const label = form.querySelector(`label[for="f-${name}"]`);
      const mark = document.createElement('span');
      mark.className = 'required-mark';
      mark.textContent = ' *';
      label.firstChild.after(mark);   // heti otsikon tekstin perään, ennen ?-ohjetta
      return { input: form.elements[name], mark };
    });
    const update = () => {
      const active = form.elements.status.value === 'active';
      marks.forEach(({ input, mark }) => {
        mark.hidden = !active;
        input.setAttribute('aria-required', String(active));
      });
    };
    form.elements.status.addEventListener('change', update);
    update();
  };

  /**
   * UI.openForm kutsuu tätä (onRender): täyttää Mainokset-valinnan valitun mainostajan
   * mainoksilla ja päivittää sen, kun mainostaja vaihtuu (eri mainostajan valinnat poistuvat).
   */
  const attachCreativePicker = (form, campaign, initial) => {
    form.querySelector('[data-multiselect="creative_ids"]').dataset.empty =
      'Valitse mainostaja, jolla on mainoksia.';
    const fill = (selected) => UI.setMultiselectOptions(form, 'creative_ids',
      creativeOptions(form.elements.advertiser_id.value, campaign?.id), selected);
    fill(initial);
    form.elements.advertiser_id.addEventListener('change', () => fill([]));
  };

  /** Piirtää kampanjataulukon (wireframen sarakkeet). Nimen alla linkki kampanjan mainoksiin. */
  const render = () => {
    countEl.textContent = `Kampanjat (${campaigns.length})`;
    if (!campaigns.length) {
      UI.tableMessage(tbody, COLS, 'Ei hakuehtoja vastaavia kampanjoita.');
      pager.slice([]);
      return;
    }
    tbody.innerHTML = pager.slice(campaigns).map((c) => `
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
  const openEditor = async (campaign) => {
    const isNew = !campaign;
    // Mainokset haetaan joka kerta, jotta valinta näyttää ajantasaiset kampanjat
    try {
      creatives = await Api.get('/api/creatives');
    } catch (err) {
      UI.toast(err.message, 'error');
      return;
    }
    const values = campaign ? toFormValues(campaign) : { status: 'active', placement_ids: [], creative_ids: [] };
    UI.openForm({
      title: isNew ? 'Luo uusi kampanja' : 'Muokkaa kampanjaa',
      fields: fields(),
      // Aktiivisella kampanjalla on oltava molemmat päivät (palvelin vaatii saman), ja
      // päättymispäivä ei voi olla ennen aloituspäivää. Uusi tai muutettu päivä ei voi olla
      // menneisyydessä (tämä päivä käy); jo tallennettu mennyt päivä saa jäädä ennalleen,
      // jotta käynnissä olevaa tai päättynyttä kampanjaa voi yhä muokata (palvelin: dates.py).
      validate: (data) => {
        const active = data.status === 'active';
        const past = (name) => data[name] && data[name] < UI.todayInput() && data[name] !== values[name];
        return {
          start_date: active && !data.start_date ? 'Aktiiviselle kampanjalle on annettava aloituspäivä.'
            : past('start_date') ? 'Aloituspäivä ei voi olla menneisyydessä. Valitse tämä päivä tai tuleva päivä.' : '',
          end_date: active && !data.end_date ? 'Aktiiviselle kampanjalle on annettava päättymispäivä.'
            : past('end_date') ? 'Päättymispäivä ei voi olla menneisyydessä. Valitse tämä päivä tai tuleva päivä.'
              : data.start_date && data.end_date && data.end_date < data.start_date
                ? 'Päättymispäivä ei voi olla ennen aloituspäivää.' : '',
        };
      },
      values,
      submitLabel: isNew ? 'Luo kampanja' : 'Tallenna',
      onRender: (form) => {
        attachCreativePicker(form, campaign, values.creative_ids);
        attachDateRequirement(form);
      },
      onSubmit: async (data) => {
        const payload = toPayload(data);
        if (isNew) await Api.post('/api/campaigns', payload);
        else await Api.put(`/api/campaigns/${campaign.id}`, payload);
        load();
        // Onnistumisilmoitus kulmaan kuten muillakin sivuilla (päätös P7)
        UI.toast(isNew ? 'Kampanja luotu.' : 'Muutokset tallennettu.');
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
      message: `Haluatko varmasti poistaa kampanjan "${c.name}"? Kampanjan mainokset säilyvät, mutta ne irrotetaan kampanjasta.`,
    });
    if (!ok) return;
    // Poisto kumottavissa 10 s (Kumoa-painike ilmoituksessa)
    UI.deleteWithUndo({ path: `/api/campaigns/${c.id}`, message: `Kampanja "${c.name}" poistettu.`, reload: load });
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
  // Suodatuksen muuttuessa palataan sivutuksen ensimmäiselle sivulle.
  const reload = () => { pager.reset(); load(); };
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(reload, 300);
  });
  statusFilter.addEventListener('change', reload);
  advertiserFilter.addEventListener('change', reload);
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
