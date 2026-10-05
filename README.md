# Louhi Ads

Louhen sisäinen mainonnanhallintajärjestelmä. Sillä hallitaan Louhen omissa digitaalisissa
ympäristöissä (Konsoli, louhi.fi, Domain Control Panel, tukiportaali, cPanel) näytettäviä
konsernin sisäisiä mainoksia: SaaShop, Getafix, Pilvi, Goodi ja Louhi.

Järjestelmä koostuu kolmesta osasta:

```
Louhen sivusto  ──  louhi-ads.js (mainostagi)  ──►  Backend / API  ◄──  Hallintapaneeli
                                                        │
                                                    PostgreSQL
```

## Tekniikka

| Osa | Tekniikka |
|-----|-----------|
| Hallintapaneeli | HTML, CSS, JavaScript (ei kehyksiä) |
| Backend | Python, FastAPI |
| Tietokanta | PostgreSQL |
| Mainostagi | `louhi-ads.js` (kevyt, ei riippuvuuksia) |

## Kansiorakenne

```
LouhiAds/
├── login.html               kirjautuminen
├── dashboard.html           etusivu: kampanjat tiloittain, päivän näytöt ja klikit
├── advertisers.html         mainostajat
├── campaigns.html           kampanjat
├── creatives.html           mainokset ja kuvien lataus
├── placements.html          mainospaikat ja upotuskoodit
├── reporting.html           raportointi ja CSV-vienti
├── users.html               käyttäjähallinta (Admin)
├── ad-demo.html             mainostagin testisivu
├── louhi-ads.js             mainostagi
├── css/style.css            tyylit
├── js/
│   ├── api.js               yhteys backendiin
│   ├── ui.js                yhteiset osat: lomakeikkuna, ilmoitukset, muotoilu
│   ├── auth.js              kirjautunut käyttäjä, roolit, uloskirjautuminen
│   └── <sivu>.js            sivukohtainen logiikka
├── media/                   ladatut mainoskuvat (syntyy automaattisesti, ei gitissä)
├── backend/                 palvelin → ks. backend/README.md
└── db/                      tietokantaskeema, testidata, migraatiot → ks. db/README.md
```

## Pikaopas

Ensimmäinen asennus on kuvattu tarkemmin tiedostoissa `db/README.md` (tietokanta) ja
`backend/README.md` (palvelin). Kun asennus on tehty, käynnistys:

```powershell
cd "K:\LAUREA\Kurssit\Digital service project\LouhiAds\backend"
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload
```

Avaa http://localhost:8000 ja kirjaudu sisään.

## Käyttäjäroolit

| Rooli | Voi |
|-------|-----|
| **Admin** | Kaiken: käyttäjät, mainostajat, mainospaikat, kampanjat, mainokset, raportit |
| **Editor** | Luoda ja muokata kampanjoita ja mainoksia, katsoa raportteja |

## Mainostagi

Mainospaikka lisätään Louhen sivulle näin (valmis koodi löytyy Mainospaikat-sivun
**Upotuskoodi**-painikkeesta):

```html
<div class="louhi-ad" data-placement="louhi_konsoli_paabanneri"></div>
<script src="http://localhost:8000/louhi-ads.js" async></script>
```

Tagi hakee mainospaikalle sopivan mainoksen, näyttää sen ja kirjaa näytön. Klikkaus kirjataan
ja käyttäjä ohjataan kohdesivulle UTM-parametreilla. Jos mainosta ei ole tai palvelin ei vastaa,
mainospaikka jää tyhjäksi eikä sivu hidastu. Testaus: http://localhost:8000/ad-demo.html

## Tilanne: MVP (tekninen määrittely, luku 20)

| # | Ominaisuus | Tila |
|---|-----------|------|
| 1 | Mainostajat | ✅ |
| 2 | Kampanjat | ✅ |
| 3 | Mainokset (kuvan lataus JPG/PNG) | ✅ |
| 4 | Mainospaikat (automaattinen Placement ID) | ✅ |
| 5 | Aloitus- ja lopetusajat | ✅ |
| 6 | Painotettu mainosten näyttö | ✅ |
| 7 | Kuva + URL -mainokset | ✅ |
| 8 | JavaScript-mainostagi | ✅ |
| 9 | Impression-seuranta | ✅ |
| 10 | Click-seuranta (+ UTM) | ✅ |
| 11 | CTR | ✅ |
| 12 | Perusraportointi | ✅ |
| 13 | CSV-export | ✅ |
| 14 | Admin- ja Editor-käyttäjät | ✅ |

**Ei vielä toteutettu:**
- Kohdennussäännöt (luku 9): `targeting_rules`-taulu on valmiina, mutta sääntöjä ei vielä
  käytetä mainoksen valinnassa eikä niitä voi muokata paneelissa.
- Automaattiset testit.
- Tuotantoympäristö (ks. `backend/README.md` → Tuotantoon vietäessä).

## Sprint-katselmoinnit

Hyväksymiskriteerien tarkistukset löytyvät projektin `sprint/`-dokumenteista:
- Mainoksen lataus
- Mainospaikan luonti

## Dokumentaatio

| Tiedosto | Sisältö |
|----------|---------|
| `backend/README.md` | Palvelimen asennus, asetukset, rajapinnat, vianetsintä |
| `db/README.md` | Tietokannan luonti, tietomalli, migraatiot |
| http://localhost:8000/docs | Rajapintojen interaktiivinen dokumentaatio (palvelimen ollessa käynnissä) |
