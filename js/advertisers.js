/* Mainostajat: listaus, haku, luonti, muokkaus ja poisto. */
(() => {
  const tbody = document.getElementById('advertisers-body');
  const countEl = document.getElementById('advertisers-count');
  const search = document.getElementById('advertiser-search');
  const COLS = 5;
  let advertisers = [];

  const fields = [
    { name: 'name', label: 'Nimi', required: true, maxlength: 100, wide: true },
    { name: 'website_url', label: 'Verkkosivu', type: 'url', placeholder: 'https://www.esimerkki.fi/', wide: true },
    { name: 'status', label: 'Tila', type: 'select', required: true,
      options: [{ value: 'active', label: 'Aktiivinen' }, { value: 'inactive', label: 'Ei aktiivinen' }] },
  ];

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

  const load = async () => {
    UI.tableMessage(tbody, COLS, 'Ladataan…');
    try {
      advertisers = await Api.get('/api/advertisers');
      render();
    } catch (err) {
      UI.tableMessage(tbody, COLS, err.message, true);
    }
  };

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
      onDelete: isNew ? null : async () => {
        if (advertiser.campaign_count > 0) {
          throw new Error('Mainostajalla on kampanjoita, joten sitä ei voi poistaa. Aseta tilaksi "Ei aktiivinen".');
        }
        await Api.del(`/api/advertisers/${advertiser.id}`);
        UI.toast('Mainostaja poistettu.');
        load();
      },
    });
  };

  tbody.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) openEditor(advertisers.find((a) => a.id === Number(edit.dataset.edit)));
  });
  search.addEventListener('input', render);
  document.getElementById('new-advertiser').addEventListener('click', () => openEditor(null));

  load();
})();
