/* Raportointi-sivu (reporting.html): näytöt, klikit ja CTR valitulta ajanjaksolta + CSV-vienti.

   Käyttäjä (admin ja editor) voi:
   - valita kampanjan (tai kaikki), ajanjakson ja ryhmittelyn (kampanja/mainos/paikka/päivä)
   - nähdä yhteenvedon (näytöt, klikit, CTR) ja taulukon sekä ladata saman raportin CSV:nä
   Tällä sivulla ei ole vain adminille rajattuja toimintoja.

   API:
   - GET /api/stats/report?start=&end=&group_by=&campaign_id=       raportin rivit (JSON)
   - GET /api/stats/report.csv?...                                  sama CSV-tiedostona
   - GET /api/campaigns                                             kampanjavalinta
   Data tulee tietokantanäkymästä v_daily_stats (päivät Suomen aikavyöhykkeellä). */
(() => {
  const campaignSel = document.getElementById('report-campaign');
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
    campaign:  [['campaign', 'Kampanja'], ['advertiser', 'Mainostaja']],
    creative:  [['creative', 'Mainos'], ['campaign', 'Kampanja']],
    placement: [['placement', 'Mainospaikka']],
    day:       [['day', 'Päivä']],
  };
  const METRICS = [['impressions', 'Näytöt'], ['clicks', 'Klikit'], ['ctr_percent', 'CTR']];

  // Päivämäärä muotoon YYYY-MM-DD paikallisen ajan mukaan. toISOString() ei kelpaa,
  // koska se muuntaa UTC-aikaan ja voisi siirtää päivää yhdellä.
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /**
   * Valittu ajanjakso -> { start, end } (YYYY-MM-DD)
   * Molemmat päivät ovat mukana, joten "7 päivää" = tänään + 6 edellistä.
   * Edellisen kuun viimeinen päivä saadaan päivällä 0 (= edellisen kuun viimeinen).
   * Oletus (myös '30') on 30 päivää.
   */
  const period = () => {
    const now = new Date();
    const daysAgo = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
    switch (periodSel.value) {
      case '7':          return { start: ymd(daysAgo(6)), end: ymd(now) };
      case 'this-month': return { start: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), end: ymd(now) };
      case 'last-month': return {
        start: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        end: ymd(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
      case '90':         return { start: ymd(daysAgo(89)), end: ymd(now) };
      default:           return { start: ymd(daysAgo(29)), end: ymd(now) };
    }
  };

  /** Kyselyparametrit; samat sekä taulukolle että CSV-viennille, jotta ne vastaavat toisiaan. */
  const params = () => ({ ...period(), group_by: groupSel.value, campaign_id: campaignSel.value });

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
    periodTitle.textContent = `Ajanjakso: ${UI.fmtDate(p.start + 'T00:00:00')}–${UI.fmtDate(p.end + 'T00:00:00')}`;
    UI.tableMessage(tbody, 5, 'Ladataan…');
    try {
      render(await Api.get('/api/stats/report', params()));
    } catch (err) {
      UI.tableMessage(tbody, 5, err.message, true);
    }
  };

  /** Täyttää kampanjavalinnan. */
  const loadCampaigns = async () => {
    const campaigns = await Api.get('/api/campaigns');
    campaignSel.innerHTML = '<option value="">Kaikki kampanjat</option>' +
      campaigns.map((c) => `<option value="${c.id}">${UI.esc(c.name)}</option>`).join('');
  };

  // CSV-vienti tavallisena siirtymänä: palvelin lähettää tiedoston latauksena
  // (Content-Disposition), joten sivu ei vaihdu. Kirjautumiseväste kulkee mukana automaattisesti.
  csvBtn.addEventListener('click', () => {
    window.location.href = '/api/stats/report.csv' + Api.query(params());
  });
  [campaignSel, periodSel, groupSel].forEach((el) => el.addEventListener('change', load));

  loadCampaigns()
    .catch((err) => UI.toast(err.message, 'error'))
    .finally(load);
})();
