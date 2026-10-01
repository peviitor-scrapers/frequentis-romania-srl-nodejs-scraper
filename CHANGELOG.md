# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-01

### Added
- Initial release in the `peviitor-scrapers` organization — derived from the [EPAM template](https://github.com/sebiboga/epam-systems-international-srl-nodejs-scraper) (v1.5.2), replacing the earlier standalone scraper
- HTML scraping for FREQUENTIS ROMANIA SRL (CIF 25475641) at https://jobs.frequentis.com/careers/SearchJobs/
- Romania location filter (`1302=[858865]`) kept in `scraper/config/scraper.json`; pagination stops when a page repeats (the site repeats the last page)
- Per-job detail fetch for workmode (hybrid / remote / on-site) and technology tags
- Default location `Cluj-Napoca` (Frequentis Romania HQ)
- All template features inherited: `scraper/config/company.json` single source of truth, 7-day ANAF cache, `docs/jobs.md` generation, 4-layer test suite, daily scheduled scraping, GitHub Pages dashboard

## License

Copyright (c) 2026 BOGA SEBASTIAN-NICOLAE
