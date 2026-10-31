/* Käyttäjät-sivu (users.html, vain Admin): listaus, luonti, muokkaus, poisto.

   Koko sivu on vain adminille: navigaatiolinkki on .admin-only, ja palvelin vaatii
   admin-roolin kaikkiin /api/users-kutsuihin (editorille 403).

   Admin voi:
   - nähdä käyttäjät, roolin, tilan ja viimeisimmän kirjautumisen
   - luoda käyttäjän, vaihtaa nimen, sähköpostin, roolin, tilan ja salasanan
   - poistaa muita käyttäjiä (omaa tiliä ei voi poistaa)
   Palvelin estää lisäksi tilanteen, jossa yhtään aktiivista adminia ei jäisi (409).

   API:
   - GET    /api/users        lista
   - POST   /api/users        uusi käyttäjä (salasana pakollinen)
   - PUT    /api/users/{id}   päivitys (tyhjä salasana = ei vaihdeta)
   - DELETE /api/users/{id}   poisto */
(() => {
  const tbody = document.getElementById('users-body');
  const countEl = document.getElementById('users-count');
  const COLS = 6;
  let users = [];

  const ROLE_OPTIONS = [
    { value: 'editor', label: 'Editor – kampanjat, mainokset, raportit' },
    { value: 'admin', label: 'Admin – kaikki oikeudet' },
  ];

  // Kentät riippuvat siitä, luodaanko uusi käyttäjä: salasana on pakollinen vain luonnissa.
  // is_active on valintalistassa merkkijonona ('true'/'false'), koska <select> käsittelee
  // vain tekstiä; muunnos booleaniksi tehdään toPayloadissa.
  const fields = (isNew) => [
    { name: 'name', label: 'Nimi', required: true, maxlength: 100 },
    { name: 'email', label: 'Sähköposti', type: 'email', required: true, maxlength: 200 },
    { name: 'role', label: 'Rooli', type: 'select', required: true, options: ROLE_OPTIONS },
    { name: 'is_active', label: 'Tila', type: 'select', required: true,
      options: [{ value: 'true', label: 'Aktiivinen' }, { value: 'false', label: 'Ei käytössä' }] },
    { name: 'password', label: isNew ? 'Salasana' : 'Uusi salasana', type: 'password', wide: true,
      required: isNew, help: isNew ? `Vähintään ${Auth.minPasswordLength()} merkkiä. Käyttäjä voi vaihtaa sen itse kirjauduttuaan.`
                                   : 'Jätä tyhjäksi, jos salasanaa ei vaihdeta.',
      validate: (v) => (v && v.length < Auth.minPasswordLength()
        ? `Salasanan on oltava vähintään ${Auth.minPasswordLength()} merkkiä pitkä.` : '') },
  ];

  const roleLabel = (r) => (r === 'admin' ? 'Admin' : 'Editor');

  /** Piirtää käyttäjätaulukon. Kirjautunut käyttäjä merkitään tekstillä "(sinä)". */
  const render = () => {
    const me = Auth.user();
    countEl.textContent = `Käyttäjät (${users.length})`;
    tbody.innerHTML = users.map((u) => `
      <tr>
        <td>${UI.esc(u.name)}${me && me.id === u.id ? ' <span class="cell-sub">(sinä)</span>' : ''}</td>
        <td class="cell-muted">${UI.esc(u.email)}</td>
        <td><span class="role-badge role-badge-${u.role}">${roleLabel(u.role)}</span></td>
        <td>${UI.pill(u.is_active ? 'active' : 'inactive')}</td>
        <td class="cell-muted">${u.last_login_at ? UI.fmtDate(u.last_login_at) : 'Ei koskaan'}</td>
        <td class="cell-actions"><button class="btn-ghost" data-edit="${u.id}">Muokkaa</button></td>
      </tr>`).join('');
  };

  /** Hakee käyttäjät ja piirtää taulukon. */
  const load = async () => {
    UI.tableMessage(tbody, COLS, 'Ladataan…');
    try {
      // Odotetaan, että kirjautunut käyttäjä on haettu (auth.js), jotta "(sinä)" ja
      // oman tilin poistoesto toimivat.
      await Auth.ready;
      users = await Api.get('/api/users');
      render();
    } catch (err) {
      UI.tableMessage(tbody, COLS, err.message, true);
    }
  };

  /** Lomakkeen data -> API:n muoto: is_active 'true'/'false' -> boolean. */
  const toPayload = (data) => ({ ...data, is_active: data.is_active === 'true' });

  /**
   * Avaa luonti-/muokkauslomakkeen. user = null -> uusi käyttäjä.
   * Salasanan pituus tarkistetaan jo selaimessa nopeaa palautetta varten; palvelin
   * tarkistaa sen joka tapauksessa.
   */
  const openEditor = (user) => {
    const isNew = !user;
    const isMe = user && Auth.user()?.id === user.id;
    UI.openForm({
      title: isNew ? 'Uusi käyttäjä' : `Muokkaa: ${user.name}`,
      fields: fields(isNew),
      values: user ? { ...user, is_active: String(user.is_active) } : { role: 'editor', is_active: 'true' },
      submitLabel: isNew ? 'Luo käyttäjä' : 'Tallenna',
      onSubmit: async (data) => {
        const payload = toPayload(data);
        const min = Auth.minPasswordLength();
        if (payload.password && payload.password.length < min) {
          throw new Error(`Salasanan on oltava vähintään ${min} merkkiä pitkä.`);
        }
        if (isNew) await Api.post('/api/users', payload);
        else await Api.put(`/api/users/${user.id}`, payload);
        UI.toast(isNew ? 'Käyttäjä luotu.' : 'Muutokset tallennettu.');
        load();
      },
      // Omaa tiliä ei voi poistaa (ei Poista-painiketta), ettei admin lukitse itseään ulos.
      onDelete: isNew || isMe ? null : async () => {
        await Api.del(`/api/users/${user.id}`);
        UI.toast('Käyttäjä poistettu.');
        load();
      },
    });
  };

  // Event delegation: rivit piirretään uudelleen joka latauksessa, joten kuunnellaan tbodya.
  tbody.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) openEditor(users.find((u) => u.id === Number(edit.dataset.edit)));
  });
  document.getElementById('new-user').addEventListener('click', () => openEditor(null));

  load();
})();
