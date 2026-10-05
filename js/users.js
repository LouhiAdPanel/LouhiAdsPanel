/* Käyttäjät (vain Admin): listaus, luonti, muokkaus, poisto. */
(() => {
  const tbody = document.getElementById('users-body');
  const countEl = document.getElementById('users-count');
  const COLS = 6;
  let users = [];

  const ROLE_OPTIONS = [
    { value: 'editor', label: 'Editor – kampanjat, mainokset, raportit' },
    { value: 'admin', label: 'Admin – kaikki oikeudet' },
  ];

  const fields = (isNew) => [
    { name: 'name', label: 'Nimi', required: true, maxlength: 100 },
    { name: 'email', label: 'Sähköposti', type: 'email', required: true, maxlength: 200 },
    { name: 'role', label: 'Rooli', type: 'select', required: true, options: ROLE_OPTIONS },
    { name: 'is_active', label: 'Tila', type: 'select', required: true,
      options: [{ value: 'true', label: 'Aktiivinen' }, { value: 'false', label: 'Ei käytössä' }] },
    { name: 'password', label: isNew ? 'Salasana' : 'Uusi salasana', type: 'password', wide: true,
      required: isNew, help: isNew ? `Vähintään ${Auth.minPasswordLength()} merkkiä. Käyttäjä voi vaihtaa sen itse kirjauduttuaan.`
                                   : 'Jätä tyhjäksi, jos salasanaa ei vaihdeta.' },
  ];

  const roleLabel = (r) => (r === 'admin' ? 'Admin' : 'Editor');

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

  const load = async () => {
    UI.tableMessage(tbody, COLS, 'Ladataan…');
    try {
      await Auth.ready;
      users = await Api.get('/api/users');
      render();
    } catch (err) {
      UI.tableMessage(tbody, COLS, err.message, true);
    }
  };

  const toPayload = (data) => ({ ...data, is_active: data.is_active === 'true' });

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
      onDelete: isNew || isMe ? null : async () => {
        await Api.del(`/api/users/${user.id}`);
        UI.toast('Käyttäjä poistettu.');
        load();
      },
    });
  };

  tbody.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) openEditor(users.find((u) => u.id === Number(edit.dataset.edit)));
  });
  document.getElementById('new-user').addEventListener('click', () => openEditor(null));

  load();
})();
