/* Kirjautumissivu */
(() => {
  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');
  const button = form.querySelector('button[type="submit"]');

  // Palataan kirjautumisen jälkeen sivulle, jolta tultiin. Vain oman sivuston
  // polut hyväksytään (estää ohjauksen ulkopuoliseen osoitteeseen).
  const nextParam = new URLSearchParams(window.location.search).get('next') || '';
  const next = /^\/(?!\/)[\w\-./?=&%]*$/.test(nextParam) && !nextParam.startsWith('/login.html')
    ? nextParam : '/dashboard.html';

  // Jos sessio on jo voimassa, suoraan sisään.
  fetch('/api/auth/me').then((r) => { if (r.ok) window.location.replace(next); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    button.disabled = true;
    button.textContent = 'Kirjaudutaan…';
    try {
      await Api.post('/api/auth/login', {
        email: form.elements.email.value.trim(),
        password: form.elements.password.value,
      });
      window.location.replace(next);
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      form.elements.password.value = '';
      form.elements.password.focus();
      button.disabled = false;
      button.textContent = 'Kirjaudu sisään';
    }
  });
})();
