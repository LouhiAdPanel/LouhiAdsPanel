# Louhi Ads – tietokanta

| Tiedosto     | Sisältö |
|--------------|---------|
| `schema.sql` | Taulut, indeksit, triggerit ja raportointinäkymät. **Pudottaa olemassa olevat taulut** – vain kehityskäyttöön. |
| `seed.sql`   | Testidata: 5 mainostajaa, 5 mainospaikkaa, 5 kampanjaa, 7 mainosta sekä keinotekoiset näytöt/klikkaukset 14 päivältä. |
| `migrations/` | Muutokset olemassa olevaan kantaan ilman datan poistoa (esim. `001_auth.sql`). |

## Käyttöönotto (Windows, PowerShell)

Aja LouhiAds-kansiossa. `psql` kysyy postgres-käyttäjän salasanan.

```powershell
# 1. Luo tietokanta (vain kerran)
psql -U postgres -c "CREATE DATABASE louhiads ENCODING 'UTF8'"

# 2. Luo taulut ja lisää testidata (voi ajaa uudelleen milloin vain)
psql -U postgres -d louhiads -v ON_ERROR_STOP=1 -f db/schema.sql -f db/seed.sql
```

Jos `psql` ei löydy, lisää PATHiin esim. `C:\Program Files\PostgreSQL\16\bin`
(versionumero asennuksen mukaan) tai käytä pgAdminin Query Toolia.

## Tarkistus

```powershell
psql -U postgres -d louhiads -c "SELECT name, display_status FROM v_campaign_status"
```

Odotettu tulos: SaaShop = active, Getafix = pending, Pilvi = ended,
Goodi = draft, Louhi = paused.

## Tietomalli

```
advertisers 1─* campaigns 1─* creatives
                campaigns *─* placements   (campaign_placements)
                campaigns 1─* targeting_rules
impressions / clicks → campaign, creative, placement, aikaleima
```

- **Kampanjan tila:** tallennetaan `draft / active / paused / archived`.
  "Odottaa alkamista" ja "Päättynyt" lasketaan päivämääristä näkymässä `v_campaign_status`.
- **Näyttöjako:** `creatives.weight`. Sama paino kaikilla = tasajako.
- **Raportointi:** `v_daily_stats` antaa päivä × kampanja × mainos × paikka -tason
  näytöt, klikit ja CTR:n (Helsingin aikavyöhyke). Tästä tehdään myös CSV-vienti.
- **Tietosuoja:** näyttö- ja klikkitauluihin ei tallenneta IP-osoitteita eikä käyttäjätunnisteita.
