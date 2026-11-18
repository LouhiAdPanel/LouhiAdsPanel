/* ============================================================
   LOUHI ADS — API-asiakas
   Kaikki hallintapaneelin kutsut backendiin kulkevat tämän kautta.
   Sivut tarjoillaan samasta palvelimesta kuin API, joten osoite
   on suhteellinen (esim. /api/campaigns).

   Käytetään: kaikilla hallintapaneelin sivuilla (dashboard, advertisers, campaigns,
   creatives, placements, environments, reporting, users) sekä login.html.

   Lisäksi: tietojen haku (GET) yritetään uudelleen 2 ja 5 sekunnin kuluttua, jos palvelin
   ei vastaa (esim. käynnistyy vasta), ja kumottavissa olevat poistot (pendingDeletes)
   jätetään listahauista pois kumoamisajan ajan (ks. UI.deleteWithUndo).
   Riippuvuudet: ei muita omia tiedostoja. Ladattava ENNEN ui.js-, auth.js-
   ja sivukohtaisia skriptejä, koska ne käyttävät globaalia Api-oliota.

   Kirjautuminen perustuu evästeeseen (sessio). fetch lähettää evästeen
   oletuksena samaan alkuperään (credentials: 'same-origin'), joten
   erillistä token-käsittelyä ei tarvita.
   ============================================================ */

// Tyhjä = sama palvelin kuin sivu. Jos API siirtyy eri osoitteeseen, vaihda tähän.
const API_BASE = '';

/**
 * Virhe, joka kantaa mukanaan HTTP-tilakoodin (0 = ei yhteyttä palvelimeen).
 * Kutsuja voi näyttää err.message-tekstin suoraan käyttäjälle.
 */
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Muuttaa backendin virhevastauksen luettavaksi suomenkieliseksi viestiksi.
 * @param {object|null} data   vastauksen JSON-runko (FastAPI: { detail: ... }) tai null
 * @param {number} status      HTTP-tila; 0 tarkoittaa verkkovirhettä
 * @returns {string} käyttäjälle näytettävä viesti
 */
function formatApiError(data, status) {
  if (!data || !data.detail) {
    // Renderin ilmaispalvelu nukahtaa 15 min käyttämättömyyden jälkeen, ja herääminen kestää
    // noin minuutin. Viesti kertoo käyttäjälle, mitä tehdä (testauksessa havaittu ongelma).
    if (status === 0) return 'Palvelin ei vastannut. Se voi olla vasta käynnistymässä – odota hetki ja yritä uudelleen.';
    return `Palvelinvirhe (${status}).`;
  }
  if (typeof data.detail === 'string') return data.detail;
  // FastAPI:n validointivirheet: [{loc: [...], msg: "..."}]
  if (Array.isArray(data.detail)) {
    return data.detail
      .map((e) => {
        // loc on esim. ['body', 'name'] -> näytetään vain kentän nimi
        const field = (e.loc || []).filter((p) => p !== 'body').join('.');
        // Pydanticin omat validaattorit lisäävät etuliitteen, jota käyttäjä ei tarvitse
        const msg = String(e.msg || '').replace(/^Value error, /, '');
        return field ? `${field}: ${msg}` : msg;
      })
      .join('\n');
  }
  return `Virhe (${status}).`;
}

/**
 * Yhteinen JSON-pyyntö backendiin. Kaikki Api.get/post/put/patch/del kulkevat tätä kautta.
 * @param {string} method  HTTP-metodi
 * @param {string} path    polku, esim. '/api/campaigns/3'
 * @param {object} [body]  lähetetään JSONina, jos annettu
 * @returns {Promise<any>} vastauksen JSON, tai null (204 No Content)
 * @throws {ApiError} verkkovirheessä tai kun vastaus ei ole 2xx
 */
/** Kumottavissa olevat poistot: poistettavan kohteen osoitteet, esim. '/api/creatives/5'.
    Täytetään UI.deleteWithUndo-funktiossa; poisto lähetetään vasta kumoamisajan jälkeen. */
const pendingDeletes = new Set();

async function request(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  // fetch heittää vain, jos palvelimeen ei saada yhteyttä (ei HTTP-virheistä). Tiedon haku
  // (GET) yritetään uudelleen kahdesti 2 ja 5 sekunnin päästä, jotta lyhyt katko tai
  // käynnistyvä palvelin ei näy käyttäjälle virheenä. Tallennuksia (POST/PUT/PATCH/DELETE)
  // ei toisteta automaattisesti, ettei sama muutos mene perille kahdesti.
  const retryDelays = method === 'GET' ? [2000, 5000] : [];
  let res;
  for (let attempt = 0; ; attempt += 1) {
    try {
      res = await fetch(API_BASE + path, options);
      break;
    } catch (err) {
      if (attempt >= retryDelays.length) throw new ApiError(formatApiError(null, 0), 0);
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }
  }

  if (res.status === 204) return null;
  // Kumottavissa olevat poistot (UI.deleteWithUndo): listahaku jättää poistettavat rivit pois,
  // jotta ne eivät palaa näkyviin, vaikka lista ladataan uudelleen kumoamisajan aikana.
  if (method === 'GET' && pendingDeletes.size && res.ok) {
    const base = path.split('?')[0];
    const data = await res.json().catch(() => null);
    return Array.isArray(data) ? data.filter((x) => !pendingDeletes.has(`${base}/${x.id}`)) : data;
  }
  // Runko ei välttämättä ole JSONia (esim. välityspalvelimen HTML-virhesivu)
  const data = await res.json().catch(() => null);

  // Sessio vanhentunut tai ei kirjautunut -> kirjautumissivulle (paitsi itse kirjautumisyritys,
  // jolloin 401 = väärä salasana ja virhe näytetään lomakkeella).
  // next-parametri vie käyttäjän kirjautumisen jälkeen takaisin samalle sivulle.
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login.html?next=${next}`;
    // Heitetään silti, ettei kutsuja jatka käsittelyä ennen sivunvaihtoa
    throw new ApiError('Kirjaudu sisään.', 401);
  }
  // 403 = kirjautunut, mutta rooli ei riitä (esim. editor yrittää admin-toimintoa)
  if (res.status === 403) throw new ApiError(formatApiError(data, 403) || 'Ei oikeuksia.', 403);
  if (!res.ok) throw new ApiError(formatApiError(data, res.status), res.status);
  return data;
}

/**
 * Rakentaa kyselymerkkijonon ja jättää tyhjät arvot pois.
 * Esim. { status: 'active', q: '' } -> '?status=active'. Palauttaa '' jos ei parametreja.
 * Tyhjät pois, jotta suodatinlomakkeen tyhjä valinta ei lähetä backendille ?status=
 */
function toQuery(params = {}) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== '') q.append(k, v);
  });
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Lähettää tiedoston sellaisenaan (ei multipart): Content-Type = tiedoston tyyppi.
 * Raaka runko pitää sekä selaimen että backendin koodin yksinkertaisena
 * (ei FormDataa eikä multipart-jäsennystä).
 * Käytetään mainosten kuvan latauksessa (UI.openForm, kenttätyyppi image).
 * @param {string} path  latausosoite
 * @param {File} file    käyttäjän valitsema tai raahaama tiedosto
 * @returns {Promise<object>} backendin vastaus (esim. { image_url, width, height })
 */
async function uploadFile(path, file) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new ApiError(formatApiError(null, 0), 0);
  }
  const data = await res.json().catch(() => null);
  // Kuten request(), mutta ilman next-paluuosoitetta
  if (res.status === 401) { window.location.href = '/login.html'; throw new ApiError('Kirjaudu sisään.', 401); }
  if (!res.ok) throw new ApiError(formatApiError(data, res.status), res.status);
  return data;
}

/**
 * Globaali API-olio, jota sivujen skriptit käyttävät, esim.
 *   const list = await Api.get('/api/campaigns', { status: 'active' });
 *   await Api.post('/api/advertisers', { name: 'Louhi' });
 * Kaikki palauttavat Promisen ja heittävät ApiErrorin virhetilanteessa.
 */
const Api = {
  get:   (path, params) => request('GET', path + toQuery(params)),
  post:  (path, body)   => request('POST', path, body),
  put:   (path, body)   => request('PUT', path, body),
  patch: (path, body)   => request('PATCH', path, body),
  del:   (path)         => request('DELETE', path),
  query: toQuery,
  upload: uploadFile,
  pendingDeletes,
};
