/* ============================================================
   LOUHI ADS — API-asiakas
   Kaikki hallintapaneelin kutsut backendiin kulkevat tämän kautta.
   Sivut tarjoillaan samasta palvelimesta kuin API, joten osoite
   on suhteellinen (esim. /api/campaigns).
   ============================================================ */

const API_BASE = '';

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Muuttaa backendin virhevastauksen luettavaksi suomenkieliseksi viestiksi. */
function formatApiError(data, status) {
  if (!data || !data.detail) {
    if (status === 0) return 'Palvelimeen ei saatu yhteyttä. Onko backend käynnissä?';
    return `Palvelinvirhe (${status}).`;
  }
  if (typeof data.detail === 'string') return data.detail;
  // FastAPI:n validointivirheet: [{loc: [...], msg: "..."}]
  if (Array.isArray(data.detail)) {
    return data.detail
      .map((e) => {
        const field = (e.loc || []).filter((p) => p !== 'body').join('.');
        const msg = String(e.msg || '').replace(/^Value error, /, '');
        return field ? `${field}: ${msg}` : msg;
      })
      .join('\n');
  }
  return `Virhe (${status}).`;
}

async function request(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(API_BASE + path, options);
  } catch (err) {
    throw new ApiError(formatApiError(null, 0), 0);
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);

  // Sessio vanhentunut tai ei kirjautunut -> kirjautumissivulle (paitsi itse kirjautumisyritys)
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login.html?next=${next}`;
    throw new ApiError('Kirjaudu sisään.', 401);
  }
  if (res.status === 403) throw new ApiError(formatApiError(data, 403) || 'Ei oikeuksia.', 403);
  if (!res.ok) throw new ApiError(formatApiError(data, res.status), res.status);
  return data;
}

/** Rakentaa kyselymerkkijonon ja jättää tyhjät arvot pois. */
function toQuery(params = {}) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== '') q.append(k, v);
  });
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Lähettää tiedoston sellaisenaan (ei multipart): Content-Type = tiedoston tyyppi. */
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
  if (res.status === 401) { window.location.href = '/login.html'; throw new ApiError('Kirjaudu sisään.', 401); }
  if (!res.ok) throw new ApiError(formatApiError(data, res.status), res.status);
  return data;
}

const Api = {
  get:   (path, params) => request('GET', path + toQuery(params)),
  post:  (path, body)   => request('POST', path, body),
  put:   (path, body)   => request('PUT', path, body),
  patch: (path, body)   => request('PATCH', path, body),
  del:   (path)         => request('DELETE', path),
  query: toQuery,
  upload: uploadFile,
};
