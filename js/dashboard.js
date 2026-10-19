/* ============================================================
   LOUHI ADS — etusivu (dashboard)
   Kampanjat tiloittain, päivän luvut ja viimeisimmät kampanjat.

   Käytetään: dashboard.html (elementtien id:t, esim. stat-active,
   status-pending, recent-campaigns-body, tulevat sieltä).
   Riippuvuudet: api.js (Api.get) ja ui.js (muotoilu, pill, toast,
   tableMessage). Tervehdyksen käyttäjän nimellä hoitaa auth.js.
   ============================================================ */
(() => {
  const today = new Date();
  document.getElementById('dashboard-date').textContent =
    `Tässä kampanjoidesi tilanne tänään, ${UI.fmtDate(today)}.`;

  const setText = (id, value) => { document.getElementById(id).textContent = value; };
  const tbody = document.getElementById('recent-campaigns-body');
  const COLS = 5; // taulukon sarakemäärä, tarvitaan viestirivin colspaniin

  /** Hakee tunnusluvut (aktiiviset kampanjat, päivän näytöt ja klikit) yläkortteihin.
      Virhe näytetään toastina, jotta muu etusivu toimii silti. */
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

  /** Hakee kaikki kampanjat kerran ja laskee niistä sekä tilakorttien määrät
      että viiden viimeksi muokatun listan (ei erillisiä API-kutsuja). */
  const loadCampaigns = async () => {
    UI.tableMessage(tbody, COLS, 'Ladataan…');
    try {
      const campaigns = await Api.get('/api/campaigns');

      // Tilakortit. display_status on backendin laskema näkyvä tila (huomioi
      // myös alku- ja loppupäivän), siksi sitä käytetään eikä tallennettua tilaa.
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
      // Kaikki tekstit UI.esc():n läpi (XSS-esto), koska nimet ovat käyttäjän syöttämiä
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

  // Haut käynnistetään rinnakkain; kumpikin käsittelee omat virheensä
  loadSummary();
  loadCampaigns();
})();
