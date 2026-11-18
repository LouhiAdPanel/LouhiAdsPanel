/* Raportointi-sivu (reporting.html): näytöt, klikit ja CTR valitulta ajanjaksolta + CSV-vienti.

   Käyttäjä (admin ja editor) voi:
   - valita ajanjakson (oletus kuluva kuukausi, edellinen kuukausi tai oma aloitus- ja
     loppupäivä), rajata raportin mainostajaan ja/tai kampanjaan ja valita ryhmittelyn
     (mainostaja/kampanja/mainos/paikka/päivä). Mainostajan valinta rajaa kampanjalistan
     kyseisen mainostajan kampanjoihin.
   - nähdä yhteenvedon (näytöt, klikit, CTR) ja taulukon sekä ladata saman raportin CSV-tiedostona
   Tällä sivulla ei ole vain adminille rajattuja toimintoja.

   API:
   - GET /api/stats/report?start=&end=&group_by=&advertiser_id=&campaign_id=  rivit (JSON)
   - GET /api/stats/report.csv?...                                  sama CSV-tiedostona
   - GET /api/advertisers, /api/campaigns                           valintalistat
   Data tulee tietokantanäkymästä v_daily_stats (päivät Suomen aikavyöhykkeellä). */
(() => {
  const advertiserSel = document.getElementById('report-advertiser');
  const campaignSel = document.getElementById('report-campaign');
  let campaigns = [];
  const periodSel = document.getElementById('report-period');
  const groupSel = document.getElementById('report-group');
  const periodTitle = document.getElementById('report-period-title');
  const thead = document.getElementById('report-head');
  const tbody = document.getElementById('report-body');
  const csvBtn = document.getElementById('report-csv');

  // Ryhmittelyn sarakkeet: [kenttä, otsikko]
  // Avain = group_by-arvo. Taulukon otsikot vaihtuvat ryhmittelyn mukaan; mittarit
  // (METRICS) ovat aina lopussa. Kenttien nimet vastaavat API:n palauttamia sarakkeita.
  const COLUMNS = {
    advertiser: [['advertiser', 'Mainostaja']],
    campaign:  [['campaign', 'Kampanja'], ['advertiser', 'Mainostaja']],
    creative:  [['creative', 'Mainos'], ['advertiser', 'Mainostaja'], ['campaign', 'Kampanja']],
    placement: [['placement', 'Mainospaikka']],
    day:       [['day', 'Päivä']],
  };
  const METRICS = [['impressions', 'Näytöt'], ['clicks', 'Klikit'], ['ctr_percent', 'CTR']];

  // Päivämäärä muotoon YYYY-MM-DD paikallisen ajan mukaan. toISOString() ei kelpaa,
  // koska se muuntaa UTC-aikaan ja voisi siirtää päivää yhdellä.
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /* ---------- Ajanjakso ----------
     Oletuksena kuluva kuukausi: kuun 1. päivästä tähän päivään. Pikavalinnat: Tämä kuukausi,
     Edellinen kuukausi ja Valitse ajanjakso. Valikon oikealla puolella ovat aloitus- ja
     loppupäivä, jotka näyttävät aina valitun jakson. Pikavalinta täyttää päivät; kun käyttäjä
     muuttaa päivää itse, valikoksi vaihtuu "Valitse ajanjakso". Molemmat päivät ovat mukana. */
  const startInput = document.getElementById('report-start');
  const endInput = document.getElementById('report-end');

  /** Pikavalinnan päivät { start, end } (YYYY-MM-DD). Edellisen kuun viimeinen päivä =
      tämän kuun päivä 0. */
  const presetRange = (value) => {
    const now = new Date();
    if (value === 'last-month') {
      return {
        start: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        end: ymd(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
    }
    return { start: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), end: ymd(now) };
  };

  /** Täyttää päiväkentät pikavalinnan mukaan ("Valitse ajanjakso" jättää ne ennalleen). */
  const applyPreset = () => {
    if (periodSel.value === 'custom') return;
    const r = presetRange(periodSel.value);
    startInput.value = r.start;
    endInput.value = r.end;
  };

  /** Valittu ajanjakso päiväkentistä { start, end }. */
  const period = () => ({ start: startInput.value, end: endInput.value });

  /** Virheteksti, jos ajanjakso ei kelpaa ('' = kunnossa). */
  const periodError = () => {
    const { start, end } = period();
    if (!start || !end) return 'Valitse ajanjakson aloitus- ja loppupäivä.';
    if (end < start) return 'Loppupäivä ei voi olla ennen aloituspäivää.';
    return '';
  };

  /** Kyselyparametrit; samat sekä taulukolle että CSV-viennille, jotta ne vastaavat toisiaan. */
  const params = () => ({
    ...period(), group_by: groupSel.value,
    advertiser_id: advertiserSel.value, campaign_id: campaignSel.value,
  });

  /**
   * Laskee yhteenvetoluvut riveistä. Kokonais-CTR lasketaan summista (klikit / näytöt),
   * EI rivien CTR-prosenttien keskiarvona, joka vääristyisi pienillä riveillä.
   * Number() varmistaa, että lasketaan lukuina eikä yhdistetä merkkijonoja.
   */
  const setSummary = (rows) => {
    const imp = rows.reduce((s, r) => s + Number(r.impressions), 0);
    const clk = rows.reduce((s, r) => s + Number(r.clicks), 0);
    document.getElementById('sum-impressions').textContent = UI.fmtInt(imp);
    document.getElementById('sum-clicks').textContent = UI.fmtInt(clk);
    document.getElementById('sum-ctr').textContent = imp ? UI.fmtPct((100 * clk) / imp) : '–';
  };

  /**
   * Piirtää otsikkorivin ja taulukon ryhmittelyn mukaan. Lukusarakkeet muotoillaan
   * suomalaisittain; ctr_percent on null, kun näyttöjä ei ole (ei jakoa nollalla).
   * Päivään lisätään 'T00:00:00', jotta se tulkitaan paikallisena eikä UTC-aikana.
   */
  const render = (rows) => {
    const cols = [...COLUMNS[groupSel.value], ...METRICS];
    thead.innerHTML = `<tr>${cols.map(([, label]) => `<th>${label}</th>`).join('')}</tr>`;
    setSummary(rows);
    if (!rows.length) {
      UI.tableMessage(tbody, cols.length, 'Valitulla ajanjaksolla ei ole näyttöjä.');
      return;
    }
    tbody.innerHTML = rows.map((r) => `<tr>${cols.map(([key]) => {
      if (key === 'impressions' || key === 'clicks') return `<td class="cell-num">${UI.fmtInt(Number(r[key]))}</td>`;
      if (key === 'ctr_percent') return `<td class="cell-num">${UI.fmtPct(r[key] === null ? null : Number(r[key]))}</td>`;
      if (key === 'day') return `<td>${UI.fmtDate(r.day + 'T00:00:00')}</td>`;
      return `<td>${UI.esc(r[key])}</td>`;
    }).join('')}</tr>`).join('');
  };

  /** Päivittää ajanjakson otsikon ja hakee raportin. */
  const load = async () => {
    const p = period();
    const err = periodError();
    [startInput, endInput].forEach((el) => el.classList.toggle('is-invalid', Boolean(err)));
    csvBtn.disabled = Boolean(err);
    if (err) {
      periodTitle.textContent = 'Ajanjakso';
      UI.tableMessage(tbody, 5, err, true);
      setSummary([]);
      return;
    }
    periodTitle.textContent = `Ajanjakso: ${UI.fmtDate(p.start + 'T00:00:00')}–${UI.fmtDate(p.end + 'T00:00:00')}`;
    UI.tableMessage(tbody, 5, 'Ladataan…');
    try {
      render(await Api.get('/api/stats/report', params()));
    } catch (err) {
      UI.tableMessage(tbody, 5, err.message, true);
    }
  };

  /** Kampanjavalinta: valitun mainostajan kampanjat (tai kaikki). Valinta säilyy, jos mahdollista. */
  const fillCampaigns = () => {
    const adv = advertiserSel.value;
    const prev = campaignSel.value;
    const list = adv ? campaigns.filter((c) => String(c.advertiser_id) === adv) : campaigns;
    campaignSel.innerHTML = '<option value="">Kaikki kampanjat</option>' +
      list.map((c) => `<option value="${c.id}">${UI.esc(c.name)}</option>`).join('');
    campaignSel.value = list.some((c) => String(c.id) === prev) ? prev : '';
  };

  /** Täyttää mainostaja- ja kampanjavalinnat. */
  const loadLookups = async () => {
    const [advertisers, camps] = await Promise.all([Api.get('/api/advertisers'), Api.get('/api/campaigns')]);
    campaigns = camps;
    advertiserSel.innerHTML = '<option value="">Kaikki mainostajat</option>' +
      advertisers.map((a) => `<option value="${a.id}">${UI.esc(a.name)}</option>`).join('');
    fillCampaigns();
  };

  // Vienti tavallisena siirtymänä: palvelin lähettää tiedoston latauksena
  // (Content-Disposition), joten sivu ei vaihdu. Kirjautumiseväste kulkee mukana automaattisesti.
  csvBtn.addEventListener('click', () => {
    window.location.href = '/api/stats/report.csv' + Api.query(params());
  });
  advertiserSel.addEventListener('change', () => { fillCampaigns(); load(); });
  [campaignSel, groupSel].forEach((el) => el.addEventListener('change', load));
  periodSel.addEventListener('change', () => { applyPreset(); load(); });
  // Päivän muuttaminen itse = oma ajanjakso
  [startInput, endInput].forEach((el) => el.addEventListener('change', () => {
    periodSel.value = 'custom';
    load();
  }));
  applyPreset();

  loadLookups()
    .catch((err) => UI.toast(err.message, 'error'))
    .finally(load);
})();
