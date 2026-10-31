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
            ├── environments.py /api/environments ympäristöt (muokkaus vain Admin)
            ├── placements.py  /api/placements  mainospaikat
            ├── campaigns.py   /api/campaigns   kampanjat
            ├── creatives.py   /api/creatives   mainokset + kuvan lataus
            ├── stats.py       /api/stats       dashboard ja raportointi, CSV
            └── serving.py     /api/v1          mainosten jakelu ja seuranta (julkiset)
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

Aja kerran ne migraatiot, joita kantaasi ei vielä ole ajettu (eivät poista dataa,
ja saman migraation voi ajaa turvallisesti uudelleen):

```powershell
psql -U postgres -d louhiads -f ..\db\migrations\001_auth.sql                     # kirjautuminen
psql -U postgres -d louhiads -f ..\db\migrations\002_creative_campaign_optional.sql # kampanja valinnainen
psql -U postgres -d louhiads -f ..\db\migrations\003_media_in_db.sql               # kuvat tietokantaan
psql -U postgres -d louhiads -f ..\db\migrations\004_demopage_placements.sql       # demosivun mainospaikat
psql -U postgres -d louhiads -f ..\db\migrations\005_creative_placements.sql       # mainoksen mainospaikat
psql -U postgres -d louhiads -f ..\db\migrations\006_placings.sql                  # sijoitukset (PLACING)
psql -U postgres -d louhiads -f ..\db\migrations\007_campaign_placements.sql       # kampanjan sallitut paikat
psql -U postgres -d louhiads -f ..\db\migrations\008_painoarvo.sql                 # painoarvo (paino + prioriteetti yhdeksi)
psql -U postgres -d louhiads -f ..\db\migrations\009_environments.sql             # ympäristöt + uutiskirjeen mainospaikat
psql -U postgres -d louhiads -f ..\db\migrations\010_fix_encoding.sql             # ääkkösten korjaus (jos 009 näytti ä/ö väärin)
```

Vaihtoehto kehityskoneella: rakenna kanta alusta (poistaa datan) komennolla
`psql -U postgres -d louhiads -f ..\db\schema.sql -f ..\db\seed.sql`.

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
| GET | `/api/environments` | kirjautunut | Ympäristöt (+ mainospaikkojen määrä) |
| POST/PUT/DELETE | `/api/environments[/{id}]` | Admin | Ympäristön luonti / muokkaus / poisto (ei, jos paikkoja) |
| GET | `/api/placements`, `/api/placements/{id}` | kirjautunut | Mainospaikat |
| POST/PUT/DELETE | `/api/placements[/{id}]` | Admin | Mainospaikan luonti / muokkaus / poisto |
| GET/POST | `/api/campaigns?status=&advertiser_id=&q=` | kirjautunut | Kampanjat (suodattimet) / luonti |
| GET/PUT/DELETE | `/api/campaigns/{id}` | kirjautunut | Yksi kampanja (sis. `placement_ids`) |
| PATCH | `/api/campaigns/{id}/status` | kirjautunut | Aktivoi / pauseta / arkistoi |
| POST | `/api/creatives/upload` | kirjautunut | Mainoskuvan lataus (JPG/PNG) |
| GET/POST | `/api/creatives?campaign_id=&unassigned=` | kirjautunut | Mainokset / luonti (kampanja valinnainen) |
| GET/PUT/DELETE | `/api/creatives/{id}` | kirjautunut | Yksi mainos |
| GET | `/api/stats/summary` | kirjautunut | Dashboardin luvut tältä päivältä |
| GET | `/api/stats/report?group_by=&start=&end=&advertiser_id=&campaign_id=` | kirjautunut | Raportti (`advertiser`, `campaign`, `creative`, `placement`, `day`; oletus 30 pv) |
| GET | `/api/stats/report.csv` | kirjautunut | Sama CSV:nä (Excel-yhteensopiva) |
| GET | `/api/v1/ad?placement=<code>` | julkinen | Mainostagi: arvottu mainos tai 204 (ei vielä kirjaa näyttöä) |
| POST | `/api/v1/view?t=<token>` | julkinen | Näytön kirjaus, kun mainos on näkynyt (50 % / 1 s) |
| GET | `/api/v1/click/{impression_id}` | julkinen | Klikkaus näytölle + 302-ohjaus UTM-parametreilla |
| GET | `/api/v1/click?t=<token>` | julkinen | Klikkaus ennen näytön kirjausta (kirjaa näytön ja klikin) |
| GET | `/api/v1/email/img?placement=&r=` | julkinen | Uutiskirje: näyttö kirjataan kuvan avauksesta, 302 kuvaan |
| GET | `/api/v1/email/click?placement=&r=` | julkinen | Uutiskirje: klikki + 302 (utm_medium=newsletter) |
| GET | `/api/health` | julkinen | `{"status":"ok"}` = tietokantayhteys toimii |

Virheet palautetaan suomeksi: 401 (ei kirjautunut), 403 (ei oikeuksia), 404 (ei löydy),
409 (esim. mainostajalla on kampanjoita), 413 (kuva liian suuri), 422 (virheellinen syöte),
429 (liian monta kirjautumisyritystä).

## Toiminnallisuuksien yksityiskohdat

### Mainoskuvat
- Ladataan lomakkeessa (valinta tai raahaus) → `POST /api/creatives/upload`.
  Pyynnön runko on kuvatiedosto sellaisenaan (ei multipart), joten lisäpaketteja ei tarvita.
- Vain JPG ja PNG. Tyyppi tarkistetaan **tiedoston sisällöstä**, ei nimestä.
- Tallennus: tietokantaan tauluun `media_files` (säilyy pilvessäkin), mainokselle `image_url = /media/<nimi>`.
  Kuvat tarjoillaan osoitteesta `/media/<nimi>`. Vanhat levylle (`LouhiAds/media/`) ladatut kuvat toimivat edelleen.
  Leveys ja korkeus luetaan kuvasta.
- Kun mainoksen kuva vaihdetaan tai mainos poistetaan, vanha tiedosto poistetaan.
- Mainostagi saa kuvan absoluuttisena osoitteena, jotta se toimii muilla sivustoilla.

### Mainoksen koko ja mainospaikan koko
- Mainoksen kuva voi olla mainospaikkaa suurempi tai pienempi. Mainostagi (`louhi-ads.js`)
  skaalaa kuvan mainospaikan kokoon mittasuhteet säilyttäen (`object-fit: contain`).
- Jos kuvan ja paikan mittasuhteet eroavat, reunoille jää tyhjää. Lomake varoittaa tästä
  paikan kohdalla ("mittasuhde poikkeaa"), mutta valintaa ei estetä.
- Ladatun kuvan mitat luetaan aina tiedostosta palvelimella (lomakkeen arvoihin ei luoteta).

### Mainos ilman kampanjaa
- Kampanja on valinnainen: mainoksen voi lisätä ensin ja liittää kampanjaan myöhemmin.
  Mainoksia ilman kampanjaa ei näytetä sivustoilla.
- `GET /api/creatives?unassigned=true` listaa mainokset ilman kampanjaa.
- Kampanjan poisto ei poista sen mainoksia, vaan ne jäävät ilman kampanjaa.

### Placement ID
- Muodostetaan automaattisesti mainospaikan nimestä (`slug.py`):
  "Louhi Konsoli – sivupalkki" → `louhi_konsoli_sivupalkki`.
- Jos tunnus on varattu, perään lisätään `_2`, `_3` …
- Tunnusta ei voi muuttaa luonnin jälkeen, koska se on upotettu sivustojen koodiin.

### Mainoksen valinta (`/api/v1/ad`)
1. Ehdokkaat: paikkaan sijoitetut mainokset, joiden paikka, sijoitus, mainos ja mainostaja ovat
   aktiivisia ja aikataulu voimassa. Kampanjan mainoksella myös kampanjan on oltava käynnissä ja
   paikan kampanjan sallittu paikka. Painoarvo > 0.
2. Yksi mainos arvotaan painoarvojen suhteessa: todennäköisyys = mainoksen painoarvo / paikan
   kaikkien painoarvojen summa. Painoarvo (0–100, oletus 50) annetaan mainoslomakkeella ja
   tallennetaan sarakkeeseen `placings.priority` (tietokantakaavion PLACING.priority).
   Sama sääntö koskee kampanjan mainoksia ja irtomainoksia. Sarake `weight` ei ole käytössä.
3. Jos ehdokkaita ei ole, vastaus on 204 ja mainospaikka jää tyhjäksi.

### Näyttöjen ja klikkien seuranta
- **Verkkosivu:** `/api/v1/ad` vain valitsee mainoksen. Mainostagi kirjaa näytön (`POST /api/v1/view`)
  vasta, kun kuva on latautunut ja vähintään 50 % mainoksesta on ollut näkyvissä yhtäjaksoisesti
  1 sekunnin aktiivisessa välilehdessä (IAB:n näkyvyysstandardi). Mainoksenestäjän piilottamat ja
  vierittämättä jääneet mainokset eivät kasvata lukuja.
- Näytön jälkeen mainoksen linkki osoittaa `/api/v1/click/{näytön id}`. Jos käyttäjä klikkaa ennen
  näytön kirjausta, linkki `/api/v1/click?t=` kirjaa ensin näytön ja sitten klikin.
- Tunniste `t` on allekirjoitettu (HMAC-SHA256) ja vanhenee (näyttö 1 h, klikki 24 h). Avain on
  ympäristömuuttuja `TRACKING_SECRET`, tai sen puuttuessa tietokantaosoitteesta johdettu avain.
- **Uutiskirje (sähköposti):** JavaScript ei toimi, joten mainos on kuva linkin sisällä.
  Näyttö kirjataan kuvan avauksesta, klikki linkistä. `r` = vastaanottajan tunniste, jonka avulla
  kuva ja linkki arpovat saman mainoksen. Ilman mainosta palautetaan läpinäkyvä 1 px korkea kuva.

Samat todennäköisyydet näkyvät Mainospaikat-sivun Näkyvyys-näkymässä
(`GET /api/placements/{id}/visibility`).

## Testaus selaimessa

| Osoite | Mitä |
|--------|------|
| http://localhost:8000/api/health | Tietokantayhteys |
| http://localhost:8000/login.html | Kirjautuminen |
| http://localhost:8000/docs | Rajapintadokumentaatio |
| http://localhost:8000/ad-demo.html | Mainostagin testisivu (julkinen) |
| http://localhost:8000/demopage/ | Demosivu (julkinen) |
| http://localhost:8000/newsletter/ | Uutiskirjedemo (julkinen) |

## Vianetsintä

| Ongelma | Ratkaisu |
|---------|----------|
| `python was not found` | Käytä `py`-komentoa: `py -m venv .venv`. Aktivoinnin jälkeen `python` toimii. |
| `Activate.ps1 cannot be loaded … running scripts is disabled` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (vastaa `Y`). Vaihtoehto: `.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload` |
| `psql is not recognized` | Lisää PostgreSQL:n `bin`-kansio PATHiin, esim. `C:\Program Files\PostgreSQL\17\bin` |
| Tietokantavirhe käynnistyksessä / `password authentication failed` | Tarkista `.env`:n `DATABASE_URL` ja salasana. Tiedoston nimen on oltava `.env`, ei `.env.txt` (Notepad: Tallennusmuoto → Kaikki tiedostot). |
| Muutokset eivät näy selaimessa | Käynnistä palvelin uudelleen ja paina selaimessa Ctrl+F5. |
| Kirjautuminen lukittui | 5 väärää yritystä → odota 15 min tai käynnistä palvelin uudelleen. |

## Julkaisu: Render + Neon (testiympäristö)

| Osa | Palvelu | Huom. |
|-----|---------|-------|
| Backend + hallintapaneeli | Render (free web service, Frankfurt) | Nukahtaa 15 min jälkeen, herää ~30–60 s |
| PostgreSQL | Neon (free, AWS Frankfurt) | Ei vanhene |
| Mainoskuvat | Neon, taulu `media_files` | Renderin levy tyhjenee, siksi kuvat tietokannassa |

Asetukset ovat tiedostossa `render.yaml`. Käynnistyskomennon `--proxy-headers` on tärkeä:
Render purkaa HTTPS:n, ja ilman sitä mainostagin kuva- ja klikkiosoitteet olisivat `http://`.

**Uusi versio julkaistaan pushaamalla `main`-haaraan** – Render julkaisee automaattisesti.

**Tietokantamuutokset Neoniin** ajetaan omalta koneelta Neonin yhteysosoitteella:

```powershell
psql "postgresql://...neon.tech/neondb?sslmode=require" -f db/migrations/00X_nimi.sql
```

## Tuotantoon vietäessä

- HTTPS ja `COOKIE_SECURE=true`
- `CORS_ORIGINS` rajattuna Louhen omiin osoitteisiin
- `/docs` tarvittaessa pois käytöstä
- `uvicorn` ilman `--reload`-valitsinta
- `media/`-kansio pysyvälle levylle tai objektitallennukseen (määrittely luku 17)
