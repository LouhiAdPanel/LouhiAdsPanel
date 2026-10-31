/* ============================================================
   LOUHI ADS — kirjautuneen käyttäjän tiedot yläpalkkiin
   - Hakee /api/auth/me ja näyttää nimen, roolin ja nimikirjaimet
   - Lisää body-elementille luokan role-admin / role-editor:
     .admin-only -elementit näkyvät vain adminille (ks. style.css)
   - Salasanan vaihto ja uloskirjautuminen

   Käytetään: kaikilla kirjautumisen takana olevilla sivuilla (ei login.html).
   Riippuvuudet: api.js (Api) ja ui.js (UI.esc, UI.openForm, UI.toast);
   ladattava niiden jälkeen. Yläpalkin paikka .app-header-user tulee HTML:stä.

   HUOM: roolin mukainen piilotus on vain käyttöliittymän siistimistä.
   Varsinainen oikeustarkistus tehdään aina backendissä (403-vastaus).
   ============================================================ */
const Auth = (() => {
  // Kirjautunut käyttäjä (/api/auth/me-vastaus); null kunnes haku valmistuu
  let current = null;

  /** Nimikirjaimet avatariin: 'Matti Meikäläinen' -> 'MM'. Tyhjä nimi -> '?'. */
  const initials = (name) =>
    name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

  const ROLE_LABEL = { admin: 'Admin', editor: 'Editor' };

  /** Salasanan vähimmäispituus tulee backendistä (MIN_PASSWORD_LENGTH).
      Oletus 6 ennen kuin käyttäjätiedot on haettu. */
  const minPw = () => current?.min_password_length || 6;

  /**
   * Piirtää yläpalkin oikeaan reunaan käyttäjän (nimikirjaimet, nimi, rooli) sekä
   * salasana- ja uloskirjautumispainikkeet. Paikka .app-header-user tulee HTML:stä.
   * Nimi escapetaan, koska se on käyttäjän syöttämää tietoa (XSS-esto).
   */
  const renderUser = (user) => {
    const box = document.querySelector('.app-header-user');
    if (!box) return;
    box.innerHTML = `
      <div class="user-chip">
        <span class="avatar" aria-hidden="true">${UI.esc(initials(user.name))}</span>
        <div class="user-text">
          <span class="user-name">${UI.esc(user.name)}</span>
          <span class="user-role">${ROLE_LABEL[user.role] || user.role}</span>
        </div>
      </div>
      <div class="user-actions">
        <button type="button" data-auth="password">Vaihda salasana</button>
        <button type="button" data-auth="logout">Kirjaudu ulos</button>
      </div>`;
    box.querySelector('[data-auth="logout"]').addEventListener('click', logout);
    box.querySelector('[data-auth="password"]').addEventListener('click', changePassword);
  };

  /**
   * Kirjaa ulos vahvistuksen jälkeen (wireframe: "Haluatko varmasti kirjautua ulos?",
   * Peruuta / Kirjaudu ulos). Backend poistaa session, ja käyttäjä siirtyy kirjautumissivulle.
   */
  const logout = async () => {
    const ok = await UI.confirm({
      title: 'Kirjaudu ulos',
      message: 'Haluatko varmasti kirjautua ulos?',
      confirmLabel: 'Kirjaudu ulos',
      confirmCls: 'btn-primary',
    });
    if (!ok) return;   // Peruuta tai ×: ikkuna sulkeutuu ja käyttäjä jää sivulle
    try { await Api.post('/api/auth/logout'); } catch { /* ohjataan joka tapauksessa */ }
    window.location.href = '/login.html';
  };

  /**
   * Avaa salasanan vaihtolomakkeen. Täsmäävyys ja pituus tarkistetaan jo tässä
   * nopeaa palautetta varten; backend tarkistaa ne silti uudelleen, samoin
   * nykyisen salasanan oikeellisuuden. Virheet näkyvät lomakeikkunassa.
   */
  const changePassword = () => {
    UI.openForm({
      title: 'Vaihda salasana',
      submitLabel: 'Vaihda salasana',
      fields: [
        { name: 'current_password', label: 'Nykyinen salasana', type: 'password', required: true, wide: true, autocomplete: 'current-password' },
        { name: 'new_password', label: 'Uusi salasana', type: 'password', required: true, wide: true, help: `Vähintään ${minPw()} merkkiä.`,
          validate: (v) => (v.length < minPw() ? `Salasanan on oltava vähintään ${minPw()} merkkiä pitkä.` : '') },
        { name: 'confirm', label: 'Vahvista uusi salasana', type: 'password', required: true, wide: true },
      ],
      // Wireframe: täsmäämättömästä vahvistuksesta virheilmoitus (punaisena kentän alla)
      validate: (data) => ({
        confirm: data.confirm && data.new_password !== data.confirm ? 'Salasanat eivät täsmää.' : '',
      }),
      onSubmit: async (data) => {
        // Wireframe: täsmäämättömästä vahvistuksesta virheilmoitus lomakkeella
        if (data.new_password !== data.confirm) throw new Error('Salasanat eivät täsmää.');
        if (data.new_password.length < minPw()) throw new Error(`Salasanan on oltava vähintään ${minPw()} merkkiä pitkä.`);
        try {
          // confirm-kenttää ei lähetetä: se on vain käyttöliittymän tarkistusta varten
          await Api.put('/api/auth/password', {
            current_password: data.current_password,
            new_password: data.new_password,
          });
        } catch (err) {
          // Väärä nykyinen salasana (400): wireframen virheikkuna, jonka sulkeminen (×)
          // palaa Vaihda salasana -lomakkeelle (lomake jää auki, return false).
          if (err.status === 400) {
            await UI.notice({ title: 'Virhe', message: 'Nykyinen salasana on virheellinen.', type: 'error' });
            return false;
          }
          throw err;
        }
        // Lomake sulkeutuu, ja wireframen onnistumisikkuna näytetään (× sulkee sen)
        setTimeout(() => UI.notice({ title: 'Vaihda salasana', message: 'Salasanasi on vaihdettu.' }), 0);
        return undefined;
      },
    });
  };

  // Haku käynnistyy heti skriptin latautuessa. Jos sessiota ei ole, Api ohjaa
  // kirjautumissivulle (401). Sivuskriptit voivat odottaa käyttäjää:
  //   Auth.ready.then((user) => { ... })  tai  await Auth.ready
  const ready = Api.get('/api/auth/me').then((user) => {
    current = user;
    // role-admin / role-editor bodyssa: CSS piilottaa .admin-only-elementit editorilta
    document.body.classList.add(user.role === 'admin' ? 'role-admin' : 'role-editor');
    renderUser(user);
    // Etusivun tervehdys käyttäjän etunimellä
    const greeting = document.getElementById('greeting');
    if (greeting) greeting.textContent = `Terve, ${user.name.split(' ')[0]}`;
    return user;
  });

  // Julkinen rajapinta (globaali Auth-olio)
  return {
    ready,                                   // Promise<user>
    user: () => current,
    isAdmin: () => current?.role === 'admin',
    minPasswordLength: minPw,
  };
})();
