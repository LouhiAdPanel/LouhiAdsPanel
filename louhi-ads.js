/* ============================================================
   LOUHI ADS — mainostagi (määrittely luvut 4 ja 19)

   Käyttö millä tahansa Louhen sivulla:
     <div class="louhi-ad" data-placement="louhi_console_main"></div>
     <script src="https://ads.louhi.fi/louhi-ads.js" async></script>

   - Hakee jokaiselle .louhi-ad-elementille mainoksen palvelimelta.
   - Kirjaa näytön vasta, kun mainos on oikeasti näkynyt: kuva latautunut ja
     vähintään 50 % mainoksesta näkyvissä yhtäjaksoisesti 1 sekunnin
     (IAB:n näkyvyysstandardi). Klikki kirjataan palvelimen klikkiosoitteella.
   - Ei koskaan hidasta tai riko sivua: lyhyt aikakatkaisu, kaikki
     virheet ohitetaan hiljaa ja mainospaikka jää tyhjäksi.
   - Myöhemmin sivulle lisätyt mainospaikat: window.LouhiAds.refresh()

   Käytetään: ulkopuolisilla isäntäsivuilla (Louhen palvelut) sekä
   testisivulla ad-demo.html. EI hallintapaneelin sivuilla.
   Riippuvuudet: ei mitään. Tiedosto on tarkoituksella itsenäinen, koska
   isäntäsivulla ei ole api.js:ää tai ui.js:ää. Backendistä käytetään
   julkista rajapintaa GET /api/v1/ad ja POST /api/v1/view
   (ks. backend/app/routers/serving.py).

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
  // Näkyvyysehto näytön kirjaukselle: osuus mainoksesta ja yhtäjaksoinen aika
  var VIEW_RATIO = 0.5;
  var VIEW_MS = 1000;
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

    // Näyttö kirjataan vasta, kun kuva on latautunut ja mainos näkyvissä (trackView).
    // Jos kuva ei lataudu (esim. estetty), näyttöä ei kirjata.
    if (img.complete && img.naturalWidth) trackView(link, ad);
    else img.addEventListener('load', function () { trackView(link, ad); });
  }

  /**
   * Kirjaa näytön, kun vähintään VIEW_RATIO mainoksesta on ollut näkyvissä VIEW_MS
   * yhtäjaksoisesti ja välilehti on aktiivinen. Kirjataan vain kerran mainosta kohden.
   * Palvelin palauttaa klikkiosoitteen, joka liittää klikin juuri tähän näyttöön;
   * sitä ennen linkki osoittaa osoitteeseen, joka kirjaa klikatessa näytön ja klikin.
   * @param {HTMLAnchorElement} link  mainoksen linkki (näkyvyyttä seurataan tästä)
   * @param {object} ad               palvelimen vastaus (view_url)
   */
  function trackView(link, ad) {
    if (!ad.view_url) return;
    var done = false;
    var timer = null;
    var visible = false;
    var observer = null;

    function send() {
      if (done) return;
      done = true;
      if (observer) observer.disconnect();
      document.removeEventListener('visibilitychange', check);
      fetch(ad.view_url, { method: 'POST', credentials: 'omit', keepalive: true })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) { if (data && data.click_url) link.href = data.click_url; })
        .catch(function () { /* seuranta ei saa rikkoa sivua */ });
    }

    // Ajastin käy vain, kun mainos on näkyvissä JA välilehti on aktiivinen
    function check() {
      var shown = visible && document.visibilityState !== 'hidden';
      if (shown && !timer) timer = setTimeout(send, VIEW_MS);
      if (!shown && timer) { clearTimeout(timer); timer = null; }
    }

    // Hyvin vanhat selaimet ilman IntersectionObserveria: kirjataan latautuneena
    if (!window.IntersectionObserver) { send(); return; }
    observer = new IntersectionObserver(function (entries) {
      visible = entries[entries.length - 1].intersectionRatio >= VIEW_RATIO;
      check();
    }, { threshold: [0, VIEW_RATIO, 1] });
    observer.observe(link);
    document.addEventListener('visibilitychange', check);
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
