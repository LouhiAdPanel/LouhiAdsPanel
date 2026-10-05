# Louhi Ads – backend

Hallintapaneelin ja mainostagin palvelin: **FastAPI + PostgreSQL**.
Sama palvelin tarjoilee sekä rajapinnat (`/api/...`) että hallintapaneelin HTML-sivut,
joten selain ja API ovat samassa osoitteessa.

## Kansiorakenne

```
LouhiAds/
├── *.html, css/, js/          hallintapaneelin sivut (tarjoillaan tästä palvelimesta)
├── louhi-ads.js               mainostagi, joka upotetaan Louhen palveluihin
├── media/                     ladatut mainoskuvat (syntyy automaattisesti, ei gitissä)
├── db/                        schema.sql, seed.sql, migrations/
└── backend/
    ├── requirements.txt
    ├── .env.example           kopioi -> .env
    └── app/
        ├── main.py            sovellus, kirjautumisvaatimus sivuille, virheenkäsittely
        ├── auth.py            salasanat (scrypt), sessiot, Admin/Editor-tarkistukset
        ├── create_admin.py    komentorivityökalu admin-tunnuksen luontiin
        ├── db.py              tietokantayhteys + CRUD-apufunktiot
        ├── schemas.py         syötteiden validointi (Pydantic)
        ├── media.py           mainoskuvien tallennus ja JPG/PNG-tarkistus
        ├── slug.py            Placement ID:n muodostus mainospaikan nimestä
        └── routers/
            ├── auth.py        /api/auth        kirjautuminen
            ├── users.py       /api/users       käyttäjät (vain Admin)
            ├── advertisers.py /api/advertisers mainostajat
            ├── placements.py  /api/placements  mainospaikat
            ├── campaigns.py   /api/campaigns   kampanjat
            ├── creatives.py   /api/creatives   mainokset + kuvan lataus
            ├── stats.py       /api/stats       dashboard ja raportointi, CSV
            └── serving.py     /api/v1          mainostagin rajapinnat (julkiset)
```

## Asennus (Windows, PowerShell) – ensimmäinen kerta

Edellytykset: PostgreSQL asennettuna ja tietokanta luotu (ks. `db/README.md`),
Python 3.10 tai uudempi.

```powershell
cd "K:\LAUREA\Kurssit\Digital service project\LouhiAds\backend"

# 1. Virtuaaliympäristö ja riippuvuudet
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt

# 2. Asetukset: kopioi pohja ja vaihda tietokannan salasana
copy .env.example .env
notepad .env

# 3. Admin-tunnus
python -m app.create_admin

# 4. Käynnistys
uvicorn app.main:app --reload
```

Avaa selaimessa http://localhost:8000 → ohjautuu kirjautumissivulle.

### Seuraavat kerrat

```powershell
cd "K:\LAUREA\Kurssit\Digital service project\LouhiAds\backend"
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload
```

`--reload` käynnistää palvelimen uudelleen automaattisesti, kun Python-tiedostoja muutetaan.
Uusien tiedostojen tai `.env`-muutosten jälkeen kannattaa silti pysäyttää (Ctrl+C) ja käynnistää käsin.

### Tietokantamuutokset olemassa olevaan kantaan

Jos tietokanta on luotu ennen kirjautumisen lisäämistä, aja kerran (ei poista dataa):

```powershell
psql -U postgres -d louhiads -f ..\db\migrations\001_auth.sql
```

## Asetukset (`.env`)

| Muuttuja | Oletus | Kuvaus |
|----------|--------|--------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/louhiads` | Tietokantayhteys: `postgresql://KÄYTTÄJÄ:SALASANA@PALVELIN:PORTTI/KANTA` |
| `CORS_ORIGINS` | `*` | Sallitut originit pilkulla erotettuna. Tuotannossa rajattava. |
| `SESSION_HOURS` | `8` | Kuinka monta tuntia kirjautuminen on voimassa |
| `MIN_PASSWORD_LENGTH` | `6` | Salasanan vähimmäispituus (backend, admin-skripti ja lomakkeet käyttävät samaa arvoa) |
| `COOKIE_SECURE` | `false` | `true`, kun palvelin on HTTPS:n takana |
| `MAX_UPLOAD_MB` | `5` | Mainoskuvan enimmäiskoko megatavuina (huom. lomakkeen oma esitarkistus on `js/ui.js`:ssä, `MAX_IMAGE_MB = 5`) |
| `MEDIA_DIR` | `LouhiAds/media` | Mihin ladatut kuvat tallennetaan |
| `FRONTEND_DIR` | `LouhiAds` | Mistä HTML-sivut tarjoillaan |

`.env` sisältää salasanan – se on `.gitignore`ssa eikä sitä tarjoilla selaimelle.

## Käyttäjät ja roolit

| Rooli | Oikeudet |
|-------|----------|
| **Admin** | Kaikki: käyttäjät, mainostajat, mainospaikat, kampanjat, mainokset, raportit |
| **Editor** | Kampanjat ja mainokset (luonti, muokkaus, kuvien lataus), raportit. Mainostajat ja mainospaikat vain luku. |

- Ensimmäinen admin luodaan komennolla `python -m app.create_admin`. Saman komennon voi
  ajaa uudelleen, jos admin-salasana unohtuu.
- Muut käyttäjät luodaan hallintapaneelin **Käyttäjät**-sivulla.
- Järjestelmästä ei voi poistaa tai poistaa käytöstä viimeistä aktiivista adminia.

**Tietoturva:** salasanat tallennetaan scrypt-tiivisteinä; sessio on HttpOnly-evästeessä
ja tietokantaan tallennetaan vain session tiiviste; 5 väärää kirjautumisyritystä
15 minuutissa lukitsee kirjautumisen hetkeksi; käyttöoikeudet tarkistetaan aina palvelimella.

## Rajapinnat

Kaikki dokumentoitu ja kokeiltavissa: http://localhost:8000/docs

| Metodi | Polku | Oikeus | Kuvaus |
|--------|-------|--------|--------|
| POST | `/api/auth/login` | julkinen | Kirjautuminen (asettaa evästeen) |
| POST | `/api/auth/logout` | julkinen | Uloskirjautuminen |
| GET | `/api/auth/me` | kirjautunut | Oma käyttäjä |
| PUT | `/api/auth/password` | kirjautunut | Oman salasanan vaihto |
| GET/POST | `/api/users` | Admin | Käyttäjien listaus / luonti |
| PUT/DELETE | `/api/users/{id}` | Admin | Käyttäjän muokkaus / poisto |
| GET | `/api/advertisers`, `/api/advertisers/{id}` | kirjautunut | Mainostajat |
| POST/PUT/DELETE | `/api/advertisers[/{id}]` | Admin | Mainostajan luonti / muokkaus / poisto |
| GET | `/api/placements`, `/api/placements/{id}` | kirjautunut | Mainospaikat |
| POST/PUT/DELETE | `/api/placements[/{id}]` | Admin | Mainospaikan luonti / muokkaus / poisto |
| GET/POST | `/api/campaigns?status=&advertiser_id=&q=` | kirjautunut | Kampanjat (suodattimet) / luonti |
| GET/PUT/DELETE | `/api/campaigns/{id}` | kirjautunut | Yksi kampanja (sis. `placement_ids`) |
| PATCH | `/api/campaigns/{id}/status` | kirjautunut | Aktivoi / pauseta / arkistoi |
| POST | `/api/creatives/upload` | kirjautunut | Mainoskuvan lataus (JPG/PNG) |
| GET/POST | `/api/creatives?campaign_id=` | kirjautunut | Mainokset / luonti |
| GET/PUT/DELETE | `/api/creatives/{id}` | kirjautunut | Yksi mainos |
| GET | `/api/stats/summary` | kirjautunut | Dashboardin luvut tältä päivältä |
| GET | `/api/stats/report?group_by=&start=&end=&campaign_id=` | kirjautunut | Raportti (`campaign`, `creative`, `placement`, `day`; oletus 30 pv) |
| GET | `/api/stats/report.csv` | kirjautunut | Sama CSV:nä (Excel-yhteensopiva) |
| GET | `/api/v1/ad?placement=<code>` | julkinen | Mainostagi: arvottu mainos tai 204 |
| GET | `/api/v1/click/{creative_id}?placement=<id>` | julkinen | Klikkaus + 302-ohjaus UTM-parametreilla |
| GET | `/api/health` | julkinen | `{"status":"ok"}` = tietokantayhteys toimii |

Virheet palautetaan suomeksi: 401 (ei kirjautunut), 403 (ei oikeuksia), 404 (ei löydy),
409 (esim. mainostajalla on kampanjoita), 413 (kuva liian suuri), 422 (virheellinen syöte),
429 (liian monta kirjautumisyritystä).

## Toiminnallisuuksien yksityiskohdat

### Mainoskuvat
- Ladataan lomakkeessa (valinta tai raahaus) → `POST /api/creatives/upload`.
  Pyynnön runko on kuvatiedosto sellaisenaan (ei multipart), joten lisäpaketteja ei tarvita.
- Vain JPG ja PNG. Tyyppi tarkistetaan **tiedoston sisällöstä**, ei nimestä.
- Tallennus: `LouhiAds/media/<satunnainen nimi>.png|jpg`, tietokantaan `image_url = /media/...`.
  Leveys ja korkeus luetaan kuvasta.
- Kun mainoksen kuva vaihdetaan tai mainos poistetaan, vanha tiedosto poistetaan.
- Mainostagi saa kuvan absoluuttisena osoitteena, jotta se toimii muilla sivustoilla.

### Placement ID
- Muodostetaan automaattisesti mainospaikan nimestä (`slug.py`):
  "Louhi Konsoli – sivupalkki" → `louhi_konsoli_sivupalkki`.
- Jos tunnus on varattu, perään lisätään `_2`, `_3` …
- Tunnusta ei voi muuttaa luonnin jälkeen, koska se on upotettu sivustojen koodiin.

### Mainoksen valinta (`/api/v1/ad`)
Aktiivinen mainospaikka → aktiiviset kampanjat, joiden aikaväli on käynnissä → aktiiviset
mainokset, joiden paino > 0 → korkeimman prioriteetin kampanjat → painotettu arvonta →
näyttö kirjataan. Jos sopivaa mainosta ei ole, vastaus on 204 ja mainospaikka jää tyhjäksi.

## Testaus selaimessa

| Osoite | Mitä |
|--------|------|
| http://localhost:8000/api/health | Tietokantayhteys |
| http://localhost:8000/login.html | Kirjautuminen |
| http://localhost:8000/docs | Rajapintadokumentaatio |
| http://localhost:8000/ad-demo.html | Mainostagin testisivu (julkinen) |

## Vianetsintä

| Ongelma | Ratkaisu |
|---------|----------|
| `python was not found` | Käytä `py`-komentoa: `py -m venv .venv`. Aktivoinnin jälkeen `python` toimii. |
| `Activate.ps1 cannot be loaded … running scripts is disabled` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (vastaa `Y`). Vaihtoehto: `.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload` |
| `psql is not recognized` | Lisää PostgreSQL:n `bin`-kansio PATHiin, esim. `C:\Program Files\PostgreSQL\17\bin` |
| Tietokantavirhe käynnistyksessä / `password authentication failed` | Tarkista `.env`:n `DATABASE_URL` ja salasana. Tiedoston nimen on oltava `.env`, ei `.env.txt` (Notepad: Tallennusmuoto → Kaikki tiedostot). |
| Muutokset eivät näy selaimessa | Käynnistä palvelin uudelleen ja paina selaimessa Ctrl+F5. |
| Kirjautuminen lukittui | 5 väärää yritystä → odota 15 min tai käynnistä palvelin uudelleen. |

## Tuotantoon vietäessä

- HTTPS ja `COOKIE_SECURE=true`
- `CORS_ORIGINS` rajattuna Louhen omiin osoitteisiin
- `/docs` tarvittaessa pois käytöstä
- `uvicorn` ilman `--reload`-valitsinta
- `media/`-kansio pysyvälle levylle tai objektitallennukseen (määrittely luku 17)
