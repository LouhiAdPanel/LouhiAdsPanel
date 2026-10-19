/* Mainostajat-sivu (advertisers.html): listaus, haku, luonti, muokkaus ja poisto.

   Käyttäjä voi:
   - selata mainostajia ja suodattaa niitä nimellä (haku tehdään selaimessa, ei palvelimella)
   - siirtyä mainostajan kampanjoihin klikkaamalla kampanjamäärää
   - luoda, muokata ja poistaa mainostajia (VAIN ADMIN)

   API:
   - GET    /api/advertisers        lista (sis. campaign_count, active_campaign_count, creative_count)
   - POST   /api/advertisers        uusi mainostaja          (vain admin)
   - PUT    /api/advertisers/{id}   päivitys                 (vain admin)
   - DELETE /api/advertisers/{id}   poisto                   (vain admin)

   Admin-rajaus: painikkeilla on luokka .admin-only, joka piilottaa ne editorilta (ks. auth.js).
   Varsinainen tarkistus tehdään aina palvelimella (403), piilotus on vain käytettävyyttä.

   Koko tiedosto on kääritty heti suoritettavaan funktioon (IIFE), jotta muuttujat
   eivät valu globaaliin näkyvyysalueeseen muiden sivujen skriptien kanssa. */
(() => {
  const tbody = document.getElementById('advertisers-body');
  const countEl = document.getElementById('advertisers-count');
  const search = document.getElementById('advertiser-search');
  const COLS = 5; // taulukon sarakemäärä, tarvitaan "Ladataan…"/virherivin colspaniin
  let advertisers = []; // viimeksi palvelimelta haettu lista; haku suodattaa tätä

  // Lomakkeen kentät UI.openForm-funktiolle (ks. ui.js). name = API:n kentän nimi.
  const fields = [
    { name: 'name', label: 'Nimi', required: true, maxlength: 100, wide: true },
    { name: 'website_url', label: 'Verkkosivu', type: 'url', placeholder: 'https://www.esimerkki.fi/', wide: true },
    { name: 'status', label: 'Tila', type: 'select', required: true,
      options: [{ value: 'active', label: 'Aktiivinen' }, { value: 'inactive', label: 'Ei aktiivinen' }] },
  ];

  /**
   * Piirtää taulukon advertisers-listasta hakukentän mukaan suodatettuna.
   * Kaikki käyttäjän syöttämä teksti kulkee UI.esc:n kautta (XSS-suojaus).
   */
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const rows = advertisers.filter((a) => a.name.toLowerCase().includes(q));
    countEl.textContent = `Mainostajat (${rows.length})`;
    if (!rows.length) {
      UI.tableMessage(tbody, COLS, q ? 'Ei hakua vastaavia mainostajia.' : 'Ei vielä mainostajia.');
      return;
    }
    tbody.innerHTML = rows.map((a) => `
      <tr>
        <td>
          ${UI.esc(a.name)}
          ${a.website_url ? `<a class="cell-sub" href="${UI.esc(a.website_url)}" target="_blank" rel="noopener">${UI.esc(a.website_url)}</a>` : ''}
        </td>
        <td>${UI.pill(a.status)}</td>
        <td class="cell-muted">
          <a href="campaigns.html?advertiser_id=${a.id}">${a.campaign_count}</a>
          ${a.active_campaign_count ? `<span class="cell-sub">${a.active_campaign_count} aktiivista</span>` : ''}
        </td>
        <td class="cell-muted">${a.creative_count}</td>
        <td class="cell-actions"><button class="btn-ghost admin-only" data-edit="${a.id}">Muokkaa</button></td>
      </tr>`).join('');
  };

  /** Hakee mainostajat palvelimelta ja piirtää taulukon. Virhe näytetään taulukossa. */
  const load = async () => {
    UI.tableMessage(tbody, COLS, 'Ladataan…');
    try {
      advertisers = await Api.get('/api/advertisers');
      render();
    } catch (err) {
      UI.tableMessage(tbody, COLS, err.message, true);
    }
  };

  /**
   * Avaa luonti-/muokkauslomakkeen. advertiser = null -> uusi mainostaja.
   * Tallennuksen ja poiston jälkeen lista ladataan uudelleen palvelimelta.
   */
  const openEditor = (advertiser) => {
    const isNew = !advertiser;
    UI.openForm({
      title: isNew ? 'Uusi mainostaja' : `Muokkaa: ${advertiser.name}`,
      fields,
      values: advertiser || { status: 'active' },
      submitLabel: isNew ? 'Luo mainostaja' : 'Tallenna',
      onSubmit: async (data) => {
        if (isNew) await Api.post('/api/advertisers', data);
        else await Api.put(`/api/advertisers/${advertiser.id}`, data);
        UI.toast(isNew ? 'Mainostaja luotu.' : 'Muutokset tallennettu.');
        load();
      },
      // Uudella mainostajalla ei ole Poista-painiketta (onDelete = null).
      onDelete: isNew ? null : async () => {
        // Tietokanta estää poiston (campaigns.advertiser_id ON DELETE RESTRICT), joten
        // tarkistetaan jo tässä ja annetaan selkeämpi ohje kuin palvelimen virhe.
        if (advertiser.campaign_count > 0) {
          throw new Error('Mainostajalla on kampanjoita, joten sitä ei voi poistaa. Aseta tilaksi "Ei aktiivinen".');
        }
        await Api.del(`/api/advertisers/${advertiser.id}`);
        UI.toast('Mainostaja poistettu.');
        load();
      },
    });
  };

  // Yksi kuuntelija koko taulukolle (event delegation): rivit piirretään uudelleen
  // jokaisessa renderissä, joten painikekohtaiset kuuntelijat katoaisivat.
  tbody.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) openEditor(advertisers.find((a) => a.id === Number(edit.dataset.edit)));
  });
  search.addEventListener('input', render); // suodatus muistissa olevasta listasta, ei uutta hakua
  document.getElementById('new-advertiser').addEventListener('click', () => openEditor(null));

  load();
})();
