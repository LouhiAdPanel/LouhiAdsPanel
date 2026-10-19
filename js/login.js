/* ============================================================
   LOUHI ADS — kirjautumissivu
   Lähettää sähköpostin ja salasanan backendille; onnistuessa backend
   asettaa sessioevästeen ja käyttäjä ohjataan eteenpäin.

   Käytetään: login.html (lomake #login-form, virhelaatikko #login-error).
   Riippuvuudet: api.js (Api.post). ui.js:ää ja auth.js:ää ei ladata tällä
   sivulla, koska käyttäjä ei vielä ole kirjautunut.
   Koodi on IIFE:n sisällä, jotta muuttujat eivät valu globaaleiksi.
   ============================================================ */
(() => {
  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');
  const button = form.querySelector('button[type="submit"]');

  // Palataan kirjautumisen jälkeen sivulle, jolta tultiin. Vain oman sivuston
  // polut hyväksytään (estää ohjauksen ulkopuoliseen osoitteeseen).
  // Regex: alkaa yhdellä '/' (ei '//', joka olisi toinen palvelin, esim. //evil.fi),
  // ja sisältää vain tavallisia URL-merkkejä. Ohjaus takaisin login-sivulle estetään.
  const nextParam = new URLSearchParams(window.location.search).get('next') || '';
  const next = /^\/(?!\/)[\w\-./?=&%]*$/.test(nextParam) && !nextParam.startsWith('/login.html')
    ? nextParam : '/dashboard.html';

  // Jos sessio on jo voimassa, suoraan sisään.
  // Suora fetch eikä Api.get: Api ohjaisi 401:llä login-sivulle, eli silmukkaan.
  // replace() ei jätä login-sivua selainhistoriaan (Takaisin-painike toimii järkevästi).
  fetch('/api/auth/me').then((r) => { if (r.ok) window.location.replace(next); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); // lähetetään JSONina fetchillä, ei selaimen omalla lomakelähetyksellä
    errorBox.hidden = true;
    // Painike pois käytöstä, ettei kirjautumista lähetetä kahdesti
    button.disabled = true;
    button.textContent = 'Kirjaudutaan…';
    try {
      await Api.post('/api/auth/login', {
        email: form.elements.email.value.trim(),
        password: form.elements.password.value,
      });
      window.location.replace(next);
    } catch (err) {
      // Api ei ohjaa login-kutsun 401:tä, joten virheviesti näytetään tässä.
      // Salasana tyhjennetään ja fokus siirretään siihen uutta yritystä varten.
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      form.elements.password.value = '';
      form.elements.password.focus();
      button.disabled = false;
      button.textContent = 'Kirjaudu sisään';
    }
  });
})();
