/* ============================================================
   LOUHI ADS — mainostagi (määrittely luvut 4 ja 19)

   Käyttö millä tahansa Louhen sivulla:
     <div class="louhi-ad" data-placement="louhi_console_main"></div>
     <script src="https://ads.louhi.fi/louhi-ads.js" async></script>

   - Hakee jokaiselle .louhi-ad-elementille mainoksen palvelimelta.
   - Ei koskaan hidasta tai riko sivua: lyhyt aikakatkaisu, kaikki
     virheet ohitetaan hiljaa ja mainospaikka jää tyhjäksi.
   - Myöhemmin sivulle lisätyt mainospaikat: window.LouhiAds.refresh()

   Käytetään: ulkopuolisilla isäntäsivuilla (Louhen palvelut) sekä
   testisivulla ad-demo.html. EI hallintapaneelin sivuilla.
   Riippuvuudet: ei mitään. Tiedosto on tarkoituksella itsenäinen, koska
   isäntäsivulla ei ole api.js:ää tai ui.js:ää. Backendistä käytetään
   julkista rajapintaa GET /api/v1/ad (ks. backend/app/routers/serving.py).

   Miksi vanhanaikainen tyyli (var, function, ei nuolifunktioita)?
   Skripti ajetaan vieraalla sivulla, jonka selaimia emme tunne; ES5-tyyli
   toimii mahdollisimman laajasti. Kaikki on IIFE:n sisällä, jotta muuttujat
   eivät sotke isäntäsivun globaaleja (ainoa globaali on window.LouhiAds).
   ============================================================ */
(function () {
  'use strict';

  // Mainoshaun enimmäisaika. Hidas mainospalvelin ei saa jättää paikkaa
  // odottamaan pitkäksi aikaa; aikakatkaisun jälkeen paikka jää tyhjäksi.
  var TIMEOUT_MS = 3000;
  // currentScript on luettava heti tässä: myöhemmin (esim. DOMContentLoaded-
  // käsittelijässä) se on null.
  var script = document.currentScript;
  // Palvelimen osoite päätellään skriptin omasta osoitteesta.
  // Näin sama tiedosto toimii sekä tuotannossa että paikallisessa testissä.
  var BASE = script && script.src ? new URL(script.src).origin : '';

  /**
   * Piirtää mainoksen (kuva linkin sisällä) mainospaikkaan.
   * Elementit luodaan DOM-rajapinnalla eikä innerHTML:llä, jolloin palvelimen
   * palauttamat arvot (esim. alt_text) eivät voi koskaan muuttua HTML:ksi (XSS-esto).
   * @param {HTMLElement} el  .louhi-ad-elementti
   * @param {object} ad       palvelimen vastaus: click_url, image_url, alt_text,
   *                          width, height, placement_width, placement_height, creative_id
   */
  function render(el, ad) {
    var link = document.createElement('a');
    // click_url osoittaa backendin klikkilaskuriin, joka ohjaa mainostajan sivulle
    link.href = ad.click_url;
    link.target = '_blank';
    // sponsored: kertoo hakukoneille, että linkki on maksettu mainos.
    // noopener: avattu sivu ei pääse käsiksi isäntäsivuun (window.opener).
    link.rel = 'sponsored noopener';
    link.style.lineHeight = '0'; // poistaa kuvan alle jäävän ylimääräisen raon

    var img = document.createElement('img');
    img.src = ad.image_url;
    img.alt = ad.alt_text || '';
    img.style.border = '0';

    var pw = ad.placement_width, ph = ad.placement_height;
    if (pw && ph) {
      // Skaalaus mainospaikan kokoon: linkki on täsmälleen paikan kokoinen laatikko
      // (kapealla näytöllä enintään 100 % leveä, mittasuhde säilyy aspect-ratiolla),
      // ja kuva täyttää sen mittasuhteet säilyttäen (object-fit: contain).
      // Pienempi kuva suurennetaan ja kuva keskitetään; reunoille voi jäädä tyhjää,
      // jos kuvan ja paikan mittasuhteet eroavat.
      link.style.display = 'flex';
      link.style.alignItems = 'center';
      link.style.justifyContent = 'center';
      link.style.width = pw + 'px';
      link.style.maxWidth = '100%';
      link.style.aspectRatio = pw + ' / ' + ph;
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
    } else {
      // Vanha tapa (paikan kokoa ei tiedetä): kuva omassa koossaan, kavennetaan tarvittaessa.
      // Leveys/korkeus varaavat tilan etukäteen, jotta sivu ei hypi kuvan latautuessa.
      link.style.display = 'inline-block';
      if (ad.width) img.width = ad.width;
      if (ad.height) img.height = ad.height;
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
    }

    link.appendChild(img);
    el.innerHTML = '';
    el.appendChild(link);
    // Näytetyn mainoksen id talteen: helpottaa vianetsintää selaimen kehitystyökaluilla
    el.setAttribute('data-louhi-creative', ad.creative_id);
  }

  /**
   * Hakee mainoksen yhteen mainospaikkaan. Kaikki virheet (verkko, aikakatkaisu,
   * ei mainosta) ohitetaan hiljaa: mainospaikka jää tyhjäksi eikä isäntäsivu rikkoudu.
   * @param {HTMLElement} el  elementti, jolla data-placement="<mainospaikan tunniste>"
   */
  function load(el) {
    // Merkitään paikka käsitellyksi heti, jotta refresh() ei hae samaan
    // paikkaan toista mainosta (eikä kirjaa ylimääräistä näyttöä)
    if (el.getAttribute('data-louhi-loaded')) return;
    el.setAttribute('data-louhi-loaded', '1');

    var placement = el.getAttribute('data-placement');
    // Hyvin vanhoissa selaimissa ei fetchiä -> ei mainosta, ei virhettä
    if (!placement || !window.fetch) return;

    // AbortController keskeyttää pyynnön aikakatkaisussa. Jos selain ei tue
    // sitä, pyyntö jatkuu, mutta sivu ei silti odota sitä (haku on asynkroninen).
    var controller = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);

    fetch(BASE + '/api/v1/ad?placement=' + encodeURIComponent(placement), {
      // Ei evästeitä: mainoshaku on julkinen eikä tarvitse kirjautumista, ja
      // ilman evästeitä selain ei vaadi palvelimelta tiukempia CORS-asetuksia
      credentials: 'omit',
      signal: controller ? controller.signal : undefined,
    })
      .then(function (res) {
        clearTimeout(timer);
        return res.status === 200 ? res.json() : null; // 204 = ei mainosta
      })
      .then(function (ad) { if (ad) render(el, ad); })
      .catch(function () { /* mainos ei ole sivulle kriittinen */ });
  }

  /** Käy läpi kaikki sivun mainospaikat ja lataa mainoksen niihin, joihin ei vielä ole
      ladattu. Julkinen: isäntäsivu voi kutsua tätä lisättyään paikkoja dynaamisesti. */
  function refresh() {
    var slots = document.querySelectorAll('.louhi-ad[data-placement]');
    for (var i = 0; i < slots.length; i++) load(slots[i]);
  }

  window.LouhiAds = { refresh: refresh };

  // async-skripti voi suorittua ennen kuin HTML on jäsennetty loppuun, jolloin
  // kaikkia .louhi-ad-elementtejä ei vielä ole. Odotetaan siinä tapauksessa DOMia.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
})();
