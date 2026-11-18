# Louhi Ads

Louhen sisäinen mainonnanhallintajärjestelmä. Sillä hallitaan Louhen omissa digitaalisissa
ympäristöissä (esim. Louhi Konsoli, louhi.fi, Domain Control Panel, tukiportaali, cPanel ja
uutiskirje) näytettäviä konsernin sisäisiä mainoksia: SaaShop, Getafix, Pilvi, Goodi ja Louhi.

Järjestelmä koostuu kolmesta osasta:

```
Louhen sivusto  ──  louhi-ads.js (mainostagi)  ──►  Backend / API  ◄──  Hallintapaneeli
Uutiskirje      ──  kuva + linkki             ──►        │
                                                     PostgreSQL
```

Sovellus on toteutettu Laurea-ammattikorkeakoulun Digital service project -opintojaksolla
prototyyppinä Louhi Net Oy:lle.

## Tekniikka

| Osa | Tekniikka |
|-----|-----------|
| Hallintapaneeli | HTML, CSS, JavaScript (ei kehyksiä) |
| Backend | Python 3.10+, FastAPI |
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
├── placements.html          mainospaikat, upotuskoodit ja Näkyvyys (Admin)
├── reporting.html           raportointi ja CSV-lataus
├── environments.html        ympäristöt (Admin)
├── users.html               käyttäjähallinta (Admin)
├── ad-demo.html             mainostagin testisivu (julkinen)
├── index.html               ohjaa etusivulle
├── demopage/                esimerkkiasiakkaan sivusto, jossa 3 mainospaikkaa (julkinen)
├── newsletter/              uutiskirjedemo, jossa 2 sähköpostin mainospaikkaa (julkinen)
├── louhi-ads.js             mainostagi
├── css/style.css            tyylit
├── js/
│   ├── api.js               yhteys backendiin
│   ├── ui.js                yhteiset osat: lomakeikkuna, ilmoitukset, sivutus, muotoilu
│   ├── auth.js              kirjautunut käyttäjä, roolit, salasanan vaihto, uloskirjautuminen
│   ├── password-toggle.js   salasanakenttien näytä/piilota-painike
│   ├── datepicker.js        suomenkielinen päivämäärävalitsin
│   └── <sivu>.js            sivukohtainen logiikka
├── backend/                 palvelin → ks. backend/README.md
├── db/                      tietokantaskeema, testidata, migraatiot → ks. db/README.md
└── render.yaml              testiympäristön julkaisuasetukset (Render)
```

Mainoskuvat tallennetaan tietokantaan (taulu `media_files`). Kansio `media/` on vain vanhoja,
levylle ladattuja kuvia varten, eikä se ole versionhallinnassa.

## Pikaopas

Ensimmäinen asennus on kuvattu tiedostoissa `db/README.md` (tietokanta) ja
`backend/README.md` (palvelin). Kun asennus on tehty, käynnistys LouhiAds-kansiossa:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload
```

Avaa http://localhost:8000 ja kirjaudu sisään.

## Käyttäjäroolit

| Rooli | Voi |
|-------|-----|
| **Admin** | Kaiken: käyttäjät, ympäristöt, mainostajat, mainospaikat (myös Näkyvyys), kampanjat, mainokset, raportit |
| **Editor** | Luoda ja muokata kampanjoita ja mainoksia, katsoa raportteja. Mainostajat ja mainospaikat (upotuskoodeineen) vain luku. |

## Mainostagi ja uutiskirje

Mainospaikka lisätään Louhen sivulle näin (valmis koodi löytyy Mainospaikat-sivun
**Upotuskoodi**-painikkeesta, ja siinä on palvelimen oikea osoite):

```html
<div class="louhi-ad" data-placement="louhi_konsoli_paabanneri"></div>
<script src="https://PALVELIN/louhi-ads.js" async></script>
```

Tagi hakee mainospaikalle sopivan mainoksen ja näyttää sen skaalattuna paikan kokoon. Näyttö
kirjataan vasta, kun vähintään puolet mainoksesta on ollut näkyvissä sekunnin. Klikkaus kirjataan,
ja käyttäjä ohjataan kohdesivulle UTM-parametreilla. Jos mainosta ei ole tai palvelin ei vastaa,
mainospaikka jää tyhjäksi eikä sivu hidastu. Testaus: http://localhost:8000/ad-demo.html

**Uutiskirjeessä** ei voi käyttää JavaScriptiä, joten mainos on kuva linkin sisällä
(`/api/v1/email/...`). Sähköpostiympäristön mainospaikoille Upotuskoodi-painike antaa tämän
muodon valmiina. Uutiskirjedemo: http://localhost:8000/newsletter/

**Demosivusto** (http://localhost:8000/demopage/) on esimerkkiasiakkaan verkkosivu, jolle on
upotettu kolme mainospaikkaa: `louhi_demo_hero` (300 × 600), `louhi_demo_banneri` (728 × 90) ja
`louhi_demo_sivun_loppu` (300 × 250). Mainos ilmestyy paikkaan, kun aktiivinen mainos
sijoitetaan siihen Mainokset-sivulla. Tyhjä paikka näkyy katkoviivoitettuna.

## Keskeiset käsitteet

- **Ympäristö** (Admin): Louhen palvelu tai kanava, johon mainospaikkoja luodaan. Kanava `web`
  käyttää mainostagia, `email` uutiskirjeen kuva ja linkki -upotusta. Ympäristöä, jossa on
  mainospaikkoja, ei voi poistaa.
- **Mainospaikka:** kohta sivustolla tai uutiskirjeessä. Tunnus (Placement ID) muodostuu nimestä
  ja lukitaan luonnin jälkeen.
- **Sijoitus** (taulu `placings`): mainos tietyssä mainospaikassa omalla painoarvolla (0–100),
  aikataululla ja valinnaisella kampanjalla. Mainos kuuluu mainostajalle, ja kampanja on
  valinnainen. Mainoksen osuus paikan näytöistä = painoarvo / paikan painoarvojen summa.
- **Kampanja:** mainostajan mainosten ryhmä, jolla on aikataulu ja sallitut mainospaikat.
  Kampanjan mainos näkyy vain kampanjan ollessa käynnissä ja sen sallituissa paikoissa.
- **Päivämäärät:** kampanjan ja mainoksen uusi tai muutettu aloitus- tai päättymispäivä ei voi
  olla menneisyydessä. Kun mainoksen Näkyy asti -päivä ohittuu, mainos muuttuu Ei aktiiviseksi.
- **Poisto:** poiston jälkeen ilmoituksessa on 10 sekunnin ajan Kumoa-painike.

Listasivut näyttävät 20 riviä sivulla.

## Toteutetut ominaisuudet (tekninen määrittely, luku 20)

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
| 9 | Impression-seuranta (näkyvyysperusteinen) | ✅ |
| 10 | Click-seuranta (+ UTM) | ✅ |
| 11 | CTR | ✅ |
| 12 | Perusraportointi | ✅ |
| 13 | CSV-export | ✅ |
| 14 | Admin- ja Editor-käyttäjät | ✅ |

Lisäksi: ympäristöjen hallinta, uutiskirjeen mainokset, Näkyvyys-näkymä (mainosten
näkymistodennäköisyydet) ja suomenkielinen päivämäärävalitsin.

**Jatkokehitys (ei toteutettu):**
- Kohdennussäännöt (määrittely luku 9): `targeting_rules`-taulu on valmiina, mutta sääntöjä ei
  käytetä mainoksen valinnassa eikä niitä voi muokata paneelissa.
- Listojen järjestäminen sarakkeen mukaan ja mainosten hakutoiminto.
- Erillinen käyttöohje.
- Automaattiset testit.
- Tuotantoympäristö (ks. `backend/README.md` → Tuotantoon vietäessä).

## Dokumentaatio

Projektin raportit (mm. tiedostokuvaus ja heuristiikkaraportti) luovutetaan erikseen.

| Tiedosto | Sisältö |
|----------|---------|
| `backend/README.md` | Palvelimen asennus, asetukset, rajapinnat, vianetsintä, tuotantoon vienti |
| `db/README.md` | Tietokannan luonti, tietomalli, migraatiot |
| http://localhost:8000/docs | Rajapintojen interaktiivinen dokumentaatio (palvelimen ollessa käynnissä) |
