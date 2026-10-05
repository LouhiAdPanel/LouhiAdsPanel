/* Etusivu: kampanjat tiloittain, päivän luvut ja viimeisimmät kampanjat. */
(() => {
  const today = new Date();
  document.getElementById('dashboard-date').textContent =
    `Tässä kampanjoidesi tilanne tänään, ${UI.fmtDate(today)}.`;

  const setText = (id, value) => { document.getElementById(id).textContent = value; };
  const tbody = document.getElementById('recent-campaigns-body');
  const COLS = 5;

  const loadSummary = async () => {
    try {
      const s = await Api.get('/api/stats/summary');
      setText('stat-active', UI.fmtInt(s.active_campaigns));
      setText('stat-impressions', UI.fmtInt(s.impressions_today));
      setText('stat-clicks', UI.fmtInt(s.clicks_today));
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  };

  const loadCampaigns = async () => {
    UI.tableMessage(tbody, COLS, 'Ladataan…');
    try {
      const campaigns = await Api.get('/api/campaigns');

      // Tilakortit
      const count = (st) => campaigns.filter((c) => c.display_status === st).length;
      setText('status-active', count('active'));
      setText('status-pending', count('pending'));
      setText('status-paused', count('paused'));
      setText('status-draft', count('draft'));

      // Viimeisimmät: uusimmat ensin, arkistoidut pois
      const recent = campaigns
        .filter((c) => c.display_status !== 'archived')
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .slice(0, 5);

      if (!recent.length) {
        UI.tableMessage(tbody, COLS, 'Ei vielä kampanjoita.');
        return;
      }
      tbody.innerHTML = recent.map((c) => `
        <tr>
          <td>${UI.esc(c.name)}</td>
          <td>${UI.esc(c.advertiser_name)}</td>
          <td class="cell-muted">${c.placements.map((p) => UI.esc(p.name)).join(', ') || '–'}</td>
          <td>${UI.pill(c.display_status)}</td>
          <td class="cell-muted">${UI.fmtRange(c.start_time, c.end_time)}</td>
        </tr>`).join('');
    } catch (err) {
      UI.tableMessage(tbody, COLS, err.message, true);
    }
  };

  loadSummary();
  loadCampaigns();
})();
