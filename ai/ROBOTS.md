# Robots.txt Analysis — Frequentis Careers

Sursa: https://jobs.frequentis.com/robots.txt

## Reguli relevante

```
User-agent: *
Allow: /careers
Disallow: /careers/*qtvc=
```

## Interpretare

| Cale | Accesibil? | Ce conține |
|---|---|---|
| `/careers/SearchJobs/` | ✅ Allowed | Lista de job-uri (filtrată pe România prin parametri de query) |
| `/careers/JobDetail/...` | ✅ Allowed | Pagina unui job |
| `/careers/*qtvc=` | ❌ Disallowed | Parametrul `qtvc` — scraper-ul nu îl folosește |

## Recomandare

Scraper-ul cere doar `/careers/SearchJobs/` (cu parametrii de filtrare pe România și `page`/`sort`) și paginile `/careers/JobDetail/...` ale joburilor din România, cu 1s delay între cereri și User-Agent `job_seeker_ro_spider`.

**Concluzie**: Risc minim — căile folosite sunt explicit permise.

## Diferență față de EPAM template

EPAM Careers dezactivează API-ul prin robots.txt; Frequentis permite `/careers`, deci scraper-ul nu are această limitare.
