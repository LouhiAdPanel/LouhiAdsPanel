/* ============================================================
   LOUHI ADS — mainostagi (määrittely luvut 4 ja 19)

   Käyttö millä tahansa Louhen sivulla:
     <div class="louhi-ad" data-placement="louhi_console_main"></div>
     <script src="https://ads.louhi.fi/louhi-ads.js" async></script>

   - Hakee jokaiselle .louhi-ad-elementille mainoksen palvelimelta.
   - Ei koskaan hidasta tai riko sivua: lyhyt aikakatkaisu, kaikki
     virheet ohitetaan hiljaa ja mainospaikka jää tyhjäksi.
   - Myöhemmin sivulle lisätyt mainospaikat: window.LouhiAds.refresh()
   ============================================================ */
(function () {
  'use strict';

  var TIMEOUT_MS = 3000;
  var script = document.currentScript;
  // Palvelimen osoite päätellään skriptin omasta osoitteesta.
  var BASE = script && script.src ? new URL(script.src).origin : '';

  function render(el, ad) {
    var link = document.createElement('a');
    link.href = ad.click_url;
    link.target = '_blank';
    link.rel = 'sponsored noopener';
    link.style.display = 'inline-block';
    link.style.lineHeight = '0';

    var img = document.createElement('img');
    img.src = ad.image_url;
    img.alt = ad.alt_text || '';
    if (ad.width) img.width = ad.width;
    if (ad.height) img.height = ad.height;
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.border = '0';

    link.appendChild(img);
    el.innerHTML = '';
    el.appendChild(link);
    el.setAttribute('data-louhi-creative', ad.creative_id);
  }

  function load(el) {
    if (el.getAttribute('data-louhi-loaded')) return;
    el.setAttribute('data-louhi-loaded', '1');

    var placement = el.getAttribute('data-placement');
    if (!placement || !window.fetch) return;

    var controller = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);

    fetch(BASE + '/api/v1/ad?placement=' + encodeURIComponent(placement), {
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

  function refresh() {
    var slots = document.querySelectorAll('.louhi-ad[data-placement]');
    for (var i = 0; i < slots.length; i++) load(slots[i]);
  }

  window.LouhiAds = { refresh: refresh };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
})();
