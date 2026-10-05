/* Raportointi: näytöt, klikit ja CTR valitulta ajanjaksolta + CSV-vienti. */
(() => {
  const campaignSel = document.getElementById('report-campaign');
  const periodSel = document.getElementById('report-period');
  const groupSel = document.getElementById('report-group');
  const periodTitle = document.getElementById('report-period-title');
  const thead = document.getElementById('report-head');
  const tbody = document.getElementById('report-body');
  const csvBtn = document.getElementById('report-csv');

  // Ryhmittelyn sarakkeet: [kenttä, otsikko]
  const COLUMNS = {
    campaign:  [['campaign', 'Kampanja'], ['advertiser', 'Mainostaja']],
    creative:  [['creative', 'Mainos'], ['campaign', 'Kampanja']],
    placement: [['placement', 'Mainospaikka']],
    day:       [['day', 'Päivä']],
  };
  const METRICS = [['impressions', 'Näytöt'], ['clicks', 'Klikit'], ['ctr_percent', 'CTR']];

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /** Valittu ajanjakso -> { start, end } (YYYY-MM-DD) */
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

  const params = () => ({ ...period(), group_by: groupSel.value, campaign_id: campaignSel.value });

  const setSummary = (rows) => {
    const imp = rows.reduce((s, r) => s + Number(r.impressions), 0);
    const clk = rows.reduce((s, r) => s + Number(r.clicks), 0);
    document.getElementById('sum-impressions').textContent = UI.fmtInt(imp);
    document.getElementById('sum-clicks').textContent = UI.fmtInt(clk);
    document.getElementById('sum-ctr').textContent = imp ? UI.fmtPct((100 * clk) / imp) : '–';
  };

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

  const loadCampaigns = async () => {
    const campaigns = await Api.get('/api/campaigns');
    campaignSel.innerHTML = '<option value="">Kaikki kampanjat</option>' +
      campaigns.map((c) => `<option value="${c.id}">${UI.esc(c.name)}</option>`).join('');
  };

  csvBtn.addEventListener('click', () => {
    window.location.href = '/api/stats/report.csv' + Api.query(params());
  });
  [campaignSel, periodSel, groupSel].forEach((el) => el.addEventListener('change', load));

  loadCampaigns()
    .catch((err) => UI.toast(err.message, 'error'))
    .finally(load);
})();
