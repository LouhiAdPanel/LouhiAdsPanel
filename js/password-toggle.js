/* ============================================================
   LOUHI ADS — salasanan näyttäminen ("silmä"-painike)

   Tiimin päätös P3 (Sprint 4): jokaisessa salasanakentässä on näytä/piilota-
   painike kaikissa selaimissa. Edgen oma silmä katoaa, kun kentästä siirtyy
   pois, eikä Chromessa ja Firefoxissa ole painiketta lainkaan, joten käytetään
   omaa painiketta ja piilotetaan Edgen oma (style.css, ::-ms-reveal).

   Toiminta: skripti etsii sivun kaikki salasanakentät (input[type=password]) ja
   lisää jokaisen oikeaan reunaan silmä-painikkeen. Painike vaihtaa kentän
   tyypiksi text (salasana näkyy) tai takaisin password. Myös myöhemmin sivulle
   tulevat kentät saavat painikkeen (MutationObserver), joten se toimii
   lomakeikkunoissa: Vaihda salasana, Uusi käyttäjä / Muokkaa käyttäjää.
   Lomaketta lähetettäessä salasana piilotetaan uudelleen, ettei selain tallenna
   sitä tekstikenttänä.

   Käytetään: kaikilla sivuilla, myös login.html. Ei riippuvuuksia (login-sivulla
   ei ladata ui.js:ää). Ladataan sivun lopussa, ennen sivukohtaisia skriptejä.
   ============================================================ */
(() => {
  // Silmä (näytä) ja yliviivattu silmä (piilota), currentColor = painikkeen väri
  const EYE = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M1.5 10S4.5 4 10 4s8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6Z"/><circle cx="10" cy="10" r="2.6"/></svg>';
  const EYE_OFF = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M1.5 10S4.5 4 10 4c1.6 0 3 .5 4.2 1.2M18.5 10s-3 6-8.5 6c-1.6 0-3-.5-4.2-1.2"/><path d="M8.2 8.2a2.6 2.6 0 0 0 3.6 3.6"/><path d="M3 17 17 3"/></svg>';

  /** Päivittää painikkeen kuvakkeen ja ruudunlukijan tekstin kentän tilan mukaan. */
  const sync = (input, btn) => {
    const shown = input.type === 'text';
    btn.innerHTML = shown ? EYE_OFF : EYE;
    btn.setAttribute('aria-label', shown ? 'Piilota salasana' : 'Näytä salasana');
    btn.setAttribute('aria-pressed', String(shown));
    btn.title = shown ? 'Piilota salasana' : 'Näytä salasana';
  };

  /** Lisää yhteen salasanakenttään silmä-painikkeen (vain kerran). */
  const enhance = (input) => {
    if (input.dataset.pwToggle) return;
    input.dataset.pwToggle = '1';

    // Kenttä ja painike yhteiseen kehykseen, jotta painike asettuu kentän oikeaan reunaan
    const wrap = document.createElement('span');
    wrap.className = 'password-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const btn = document.createElement('button');
    btn.type = 'button';               // ei lähetä lomaketta
    btn.className = 'password-toggle';
    btn.setAttribute('aria-controls', input.id || '');
    wrap.appendChild(btn);
    sync(input, btn);

    // mousedown estetään, jotta fokus pysyy kentässä ja kirjoittamista voi jatkaa
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      sync(input, btn);
    });

    // Lähetettäessä takaisin piiloon (selaimen salasananhallinta tunnistaa kentän)
    const form = input.form;
    if (form) {
      form.addEventListener('submit', () => {
        input.type = 'password';
        sync(input, btn);
      });
    }
  };

  const scan = (root) => {
    if (root.matches && root.matches('input[type="password"]')) enhance(root);
    if (root.querySelectorAll) root.querySelectorAll('input[type="password"]').forEach(enhance);
  };

  scan(document);
  // Lomakeikkunat (UI.openForm) lisätään sivulle myöhemmin: tarkkaillaan uusia elementtejä
  new MutationObserver((records) => {
    records.forEach((r) => r.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); }));
  }).observe(document.body, { childList: true, subtree: true });
})();
