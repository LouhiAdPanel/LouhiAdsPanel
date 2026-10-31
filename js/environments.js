/* Ympäristöt-sivu (environments.html): listaus, luonti, muokkaus ja poisto. VAIN ADMIN.

   Ympäristö = Louhen palvelu tai kanava, jossa mainospaikat ovat (esim. Louhi Konsoli,
   www, Uutiskirje). Mainospaikan lomake (placements.js) valitsee ympäristön tästä listasta.

   Kanava (channel) kertoo, miten ympäristön mainospaikat upotetaan:
   - web   = verkkosivu: mainostagi louhi-ads.js (JavaScript)
   - email = sähköposti, esim. uutiskirje: pelkkä kuva + linkki, koska sähköposti-
             ohjelmat eivät aja JavaScriptiä (ks. newsletter/ ja serving.py)

   Sivu on vain adminille: navigaatiolinkki on .admin-only, ja palvelin vaatii admin-
   roolin luontiin, muokkaukseen ja poistoon (editorille 403).

   API:
   - GET    /api/environments        lista + mainospaikkojen määrä (placement_count)
   - POST   /api/environments        uusi ympäristö (nimi yksilöllinen, 409)
   - PUT    /api/environments/{id}   päivitys; nimen muutos päivittyy myös mainospaikoille
   - DELETE /api/environments/{id}   poisto; estetty (409), jos ympäristössä on mainospaikkoja */
(() => {
  const tbody = document.getElementById('environments-body');
  const countEl = document.getElementById('environments-count');
  const COLS = 4;
  let environments = [];
  // Sivutus 20 riviä/sivu (UI.pager)
  const pager = UI.pager(document.getElementById('environments-pager'), () => render());

  const CHANNELS = [
    { value: 'web', label: 'Verkkosivu (mainostagi)' },
    { value: 'email', label: 'Sähköposti / uutiskirje' },
  ];
  const channelLabel = (c) => (CHANNELS.find((x) => x.value === c) || { label: c }).label;

  const fields = () => [
    { name: 'name', label: 'Nimi', required: true, maxlength: 100, wide: true,
      placeholder: 'Uutiskirje', help: 'Nimen on oltava yksilöllinen. Nimen muutos päivittyy ympäristön mainospaikoille.' },
    { name: 'channel', label: 'Kanava', type: 'select', required: true, wide: true, options: CHANNELS,
      tooltip: 'Verkkosivun mainospaikat upotetaan mainostagilla (JavaScript). Sähköpostissa '
        + 'JavaScript ei toimi, joten sähköpostin mainospaikat upotetaan kuvana ja linkkinä.' },
    { name: 'description', label: 'Kuvaus', type: 'textarea', maxlength: 500,
      placeholder: 'Esim. Louhen kuukausittainen asiakasuutiskirje.' },
  ];

  /** Sama nimisääntö kuin palvelimella: kirjainkoko ja ylimääräiset välilyönnit eivät erota. */
  const nameKey = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();

  const render = () => {
    countEl.textContent = `Ympäristöt (${environments.length})`;
    if (!environments.length) {
      UI.tableMessage(tbody, COLS, 'Ei vielä ympäristöjä. Luo ensimmäinen yläkulman painikkeesta.');
      pager.slice([]);
      return;
    }
    tbody.innerHTML = pager.slice(environments).map((e) => `
      <tr>
        <td>${UI.esc(e.name)}${e.description ? `<span class="cell-sub">${UI.esc(e.description)}</span>` : ''}</td>
        <td>${UI.esc(channelLabel(e.channel))}</td>
        <td class="cell-num">${e.placement_count}</td>
        <td class="cell-actions">
          <button class="btn btn-small" data-edit="${e.id}">Muokkaa</button>
          <button class="btn btn-small btn-small-danger" data-delete="${e.id}">Poista</button>
        </td>
      </tr>`).join('');
  };

  const load = async () => {
    UI.tableMessage(tbody, COLS, 'Ladataan…');
    try {
      environments = await Api.get('/api/environments');
      render();
    } catch (err) {
      UI.tableMessage(tbody, COLS, err.message, true);
    }
  };

  /** Avaa "Uusi ympäristö"- tai "Muokkaa ympäristöä" -lomakkeen. env = null -> uusi. */
  const openEditor = (env) => {
    const isNew = !env;
    UI.openForm({
      title: isNew ? 'Uusi ympäristö' : 'Muokkaa ympäristöä',
      fields: fields(),
      values: env || { channel: 'web' },
      submitLabel: isNew ? 'Luo ympäristö' : 'Tallenna muutokset',
      onRender: (form) => {
        // Sama nimi estetään jo kirjoitettaessa (palvelin tarkistaa myös, 409)
        const name = form.elements.name;
        const help = name.closest('.field').querySelector('.field-help');
        const defaultHelp = help.textContent;
        const check = () => {
          const same = environments.find((e) => e.id !== env?.id && nameKey(e.name) === nameKey(name.value));
          help.textContent = same ? `Ympäristö nimellä "${same.name}" on jo olemassa.` : defaultHelp;
          help.classList.toggle('cell-warn', Boolean(same));
          name.setCustomValidity(same ? 'Samanniminen ympäristö on jo olemassa.' : '');
        };
        name.addEventListener('input', check);
      },
      onSubmit: async (data) => {
        if (isNew) await Api.post('/api/environments', data);
        else await Api.put(`/api/environments/${env.id}`, data);
        setTimeout(() => UI.notice({ message: isNew ? 'Ympäristö luotu.' : 'Ympäristön tiedot päivitetty.' }), 0);
        load();
      },
    });
  };

  /** Poisto vahvistuksen jälkeen. Ympäristöä, jossa on mainospaikkoja, ei voi poistaa. */
  const deleteEnvironment = async (env) => {
    if (env.placement_count) {
      UI.notice({
        title: 'Ympäristöä ei voi poistaa',
        message: `Ympäristössä "${env.name}" on ${env.placement_count} mainospaikkaa. Siirrä mainospaikat toiseen ympäristöön tai poista ne ensin.`,
        type: 'error',
      });
      return;
    }
    const ok = await UI.confirm({
      title: 'Poista ympäristö',
      message: `Haluatko varmasti poistaa ympäristön ${env.name}?`,
    });
    if (!ok) return;
    try {
      await Api.del(`/api/environments/${env.id}`);
      UI.notice({ message: 'Ympäristö poistettu.' });
      load();
    } catch (err) {
      UI.notice({ title: 'Virhe', message: err.message, type: 'error' });
    }
  };

  tbody.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-delete]');
    if (edit) openEditor(environments.find((x) => x.id === Number(edit.dataset.edit)));
    if (del) deleteEnvironment(environments.find((x) => x.id === Number(del.dataset.delete)));
  });
  document.getElementById('new-environment').addEventListener('click', () => openEditor(null));

  // Editor ei pääse tälle sivulle (navigaatiolinkki on piilossa): ohjataan etusivulle.
  Auth.ready.then((user) => {
    if (user.role !== 'admin') window.location.replace('dashboard.html');
    else load();
  });
})();
