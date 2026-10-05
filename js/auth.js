/* ============================================================
   LOUHI ADS — kirjautuneen käyttäjän tiedot sivupalkkiin
   - Hakee /api/auth/me ja näyttää nimen, roolin ja nimikirjaimet
   - Lisää body-elementille luokan role-admin / role-editor:
     .admin-only -elementit näkyvät vain adminille (ks. style.css)
   - Salasanan vaihto ja uloskirjautuminen
   ============================================================ */
const Auth = (() => {
  let current = null;

  const initials = (name) =>
    name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

  const ROLE_LABEL = { admin: 'Admin', editor: 'Editor' };

  /** Salasanan vähimmäispituus tulee backendistä (MIN_PASSWORD_LENGTH). */
  const minPw = () => current?.min_password_length || 6;

  const renderSidebar = (user) => {
    const footer = document.querySelector('.sidebar-footer');
    if (!footer) return;
    footer.innerHTML = `
      <div class="user-chip">
        <span class="avatar">${UI.esc(initials(user.name))}</span>
        <div>
          <span class="user-name">${UI.esc(user.name)}</span>
          <span class="user-role">${ROLE_LABEL[user.role] || user.role}</span>
        </div>
      </div>
      <div class="user-actions">
        <button type="button" data-auth="password">Vaihda salasana</button>
        <button type="button" data-auth="logout">Kirjaudu ulos</button>
      </div>`;
    footer.querySelector('[data-auth="logout"]').addEventListener('click', logout);
    footer.querySelector('[data-auth="password"]').addEventListener('click', changePassword);
  };

  const logout = async () => {
    try { await Api.post('/api/auth/logout'); } catch { /* ohjataan joka tapauksessa */ }
    window.location.href = '/login.html';
  };

  const changePassword = () => {
    UI.openForm({
      title: 'Vaihda salasana',
      submitLabel: 'Vaihda salasana',
      fields: [
        { name: 'current_password', label: 'Nykyinen salasana', type: 'password', required: true, wide: true, autocomplete: 'current-password' },
        { name: 'new_password', label: 'Uusi salasana', type: 'password', required: true, wide: true, help: `Vähintään ${minPw()} merkkiä.` },
        { name: 'confirm', label: 'Uusi salasana uudelleen', type: 'password', required: true, wide: true },
      ],
      onSubmit: async (data) => {
        if (data.new_password !== data.confirm) throw new Error('Uudet salasanat eivät täsmää.');
        if (data.new_password.length < minPw()) throw new Error(`Salasanan on oltava vähintään ${minPw()} merkkiä pitkä.`);
        await Api.put('/api/auth/password', {
          current_password: data.current_password,
          new_password: data.new_password,
        });
        UI.toast('Salasana vaihdettu.');
      },
    });
  };

  const ready = Api.get('/api/auth/me').then((user) => {
    current = user;
    document.body.classList.add(user.role === 'admin' ? 'role-admin' : 'role-editor');
    renderSidebar(user);
    // Etusivun tervehdys käyttäjän etunimellä
    const greeting = document.getElementById('greeting');
    if (greeting) greeting.textContent = `Terve, ${user.name.split(' ')[0]}`;
    return user;
  });

  return {
    ready,                                   // Promise<user>
    user: () => current,
    isAdmin: () => current?.role === 'admin',
    minPasswordLength: minPw,
  };
})();
