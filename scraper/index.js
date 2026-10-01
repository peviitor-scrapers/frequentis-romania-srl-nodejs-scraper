import fetch from "node-fetch";
import * as cheerio from "cheerio";
import fs from "fs";
import { fileURLToPath } from "url";
import { validateAndGetCompany } from "./company.js";
import { querySOLR, upsertJobs, upsertCompany, deleteJobByUrl } from "./api.js";
import { generateJobsMarkdown } from "./markdown-generator.js";
import companyConfig from "./config/company.js";
import scraperConfig from "./config/scraper.js";

const COMPANY_CIF = companyConfig.id;
const JOB_BASE = scraperConfig.apiBase;

const TIMEOUT = 10000;

let COMPANY_NAME = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchANOFM(cif) {
  const jobs = [];
  try {
    console.log(`Searching ANOFM by CIF: ${cif}`);
    const payload = {
      current: 1,
      rowCount: 250,
      sort: { created_at: "desc" },
      employer_tax_code: cif
    };
    const res = await fetch("https://mediere.anofm.ro/api/entity/vw_public_job_posting", {
      method: "POST",
      timeout: TIMEOUT,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "job_seeker_ro_spider"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.log(`  ANOFM returned ${res.status}`);
      return jobs;
    }
    const data = await res.json();
    for (const row of data.rows || []) {
      const locationParts = (row.address_locality_name || '').split('>').map(s => s.trim());
      const location = locationParts.length > 1 ? locationParts[locationParts.length - 1] : locationParts[0];
      jobs.push({
        url: `https://mediere.anofm.ro/app/module/mediere/job/${row.id}`,
        title: row.occupation,
        location: location ? [location] : undefined,
        source: "ANOFM"
      });
    }
    console.log(`  Found ${jobs.length} jobs on ANOFM`);
  } catch (err) {
    console.log(`  ANOFM error: ${err.message}`);
  }
  return jobs;
}

const CAREER_URL = `${JOB_BASE}${scraperConfig.apiListPath}`;

const TAG_PATTERNS = [
  [/\bjava\b/i, "java"], [/\bjavascript\b/i, "javascript"], [/\bpython\b/i, "python"],
  [/\bc\+\+/i, "c++"], [/\bc#/i, "c#"], [/\bgo(lang)?\b/i, "go"],
  [/\breact\b/i, "react"], [/\bangular\b/i, "angular"], [/\bnode(\.js)?\b/i, "node"],
  [/\baws\b/i, "aws"], [/\bazure\b/i, "azure"], [/\bdocker\b/i, "docker"],
  [/\bkubernetes\b/i, "kubernetes"], [/\blinux\b/i, "linux"], [/\bagile\b/i, "agile"],
  [/\bscrum\b/i, "scrum"], [/\brest\b/i, "rest"], [/\bsql\b/i, "sql"],
  [/\bmicroservices?\b/i, "microservices"], [/\bdevops\b/i, "devops"],
  [/\bci\/cd\b/i, "ci/cd"], [/\bgit\b/i, "git"], [/\bjenkins\b/i, "jenkins"],
  [/\bansible\b/i, "ansible"], [/\bpuppet\b/i, "puppet"]
];

async function fetchJobsPage(pageNum) {
  const url = `${CAREER_URL}?${scraperConfig.romaniaFilter}&page=${pageNum}&sort=date`;

  const res = await fetch(url, {
    timeout: TIMEOUT,
    headers: {
      "User-Agent": "job_seeker_ro_spider",
      "Accept": "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) {
    throw new Error(`Search page error ${res.status} for page=${pageNum}`);
  }

  return await res.text();
}

function isRomanianJob(url, subtitle) {
  return /\/ROU-/i.test(url) || /\bromania\b|\bromânia\b/i.test(subtitle || "");
}

function parseJobListing(html) {
  const $ = cheerio.load(html);
  const jobs = [];

  $(".list__item__detail").each((_, el) => {
    const $item = $(el);
    const $a = $item.find(".list__item__text__title a").first();
    const href = ($a.attr("href") || "").trim();
    const title = $a.text().trim();
    if (!href || !title) return;

    const url = href.startsWith("http") ? href : `${JOB_BASE}${href}`;
    const subtitle = $item.find(".list__item__text__subtitle").text().replace(/\s+/g, " ").trim();

    if (!isRomanianJob(url, subtitle)) return;

    // Subtitle layout: "<Department> | <Country> | <City>, <County> | <Legal entity>"
    const segments = subtitle.split("|").map(p => p.trim());
    const countryIdx = segments.findIndex(p => /^rom[aâ]nia$/i.test(p));
    const place = (segments[countryIdx + 1] || "").split(",")[0].trim();
    jobs.push({ url, title, subtitle, place });
  });

  return jobs;
}

function detectWorkmode(text) {
  if (/hybrid/i.test(text)) return "hybrid";
  if (/remote/i.test(text) && !/on.?site|office/i.test(text)) return "remote";
  return "on-site";
}

function extractTags(text) {
  const tags = TAG_PATTERNS.filter(([re]) => re.test(text)).map(([, tag]) => tag);
  return [...new Set(tags)].slice(0, 20);
}

async function fetchJobDetails(url) {
  try {
    const res = await fetch(url, {
      timeout: TIMEOUT,
      headers: {
        "User-Agent": "job_seeker_ro_spider",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    if (!res.ok) return null;

    const $ = cheerio.load(await res.text());
    const bodyText = $("body").text();

    return { workmode: detectWorkmode(bodyText), tags: extractTags(bodyText) };
  } catch (err) {
    console.log(`  Warning: Could not fetch details for ${url}: ${err.message}`);
    return null;
  }
}

async function scrapeAllListings(testOnlyOnePage = false) {
  const allJobs = [];
  const seenUrls = new Set();
  const seenListingUrls = new Set();
  let page = 1;
  const MAX_PAGES = 10;

  while (true) {
    console.log(`Fetching search page: ${page}`);
    const html = await fetchJobsPage(page);
    const $ = cheerio.load(html);
    const listingUrls = $(".list__item__text__title a").map((_, a) => $(a).attr("href")).get();

    // The site repeats the last page for out-of-range page numbers.
    const freshListing = listingUrls.filter(u => !seenListingUrls.has(u));
    freshListing.forEach(u => seenListingUrls.add(u));
    if (!freshListing.length) {
      console.log(`No new listings on page ${page}, stopping.`);
      break;
    }

    const pageJobs = parseJobListing(html);
    let newJobs = 0;
    for (const job of pageJobs) {
      if (seenUrls.has(job.url)) continue;
      seenUrls.add(job.url);
      console.log(`  Fetching details: ${job.title}`);
      const details = await fetchJobDetails(job.url);
      allJobs.push({
        url: job.url,
        title: job.title,
        workmode: details?.workmode || "on-site",
        location: [job.place || scraperConfig.defaultLocation],
        tags: details?.tags || []
      });
      newJobs++;
      await sleep(1000);
    }

    console.log(`Page ${page}: ${pageJobs.length} Romanian jobs, ${newJobs} new (total: ${allJobs.length})`);

    if (testOnlyOnePage) {
      console.log("Test mode: stopping after page 1.");
      break;
    }

    if (page >= MAX_PAGES) {
      console.log(`Max pages (${MAX_PAGES}) reached, stopping.`);
      break;
    }

    page += 1;
    await sleep(1000);
  }

  console.log(`Total unique Romanian jobs collected: ${allJobs.length}`);
  return allJobs;
}

function mapToJobModel(rawJob, cif, companyName = COMPANY_NAME) {
  const now = new Date().toISOString();

  const job = {
    url: rawJob.url,
    title: rawJob.title,
    company: companyName,
    cif: cif,
    location: rawJob.location?.length ? rawJob.location : undefined,
    tags: rawJob.tags?.length ? rawJob.tags : undefined,
    workmode: rawJob.workmode || undefined,
    date: now,
    status: "scraped"
  };

  Object.keys(job).forEach((k) => job[k] === undefined && delete job[k]);

  return job;
}

function transformJobsForSOLR(payload) {
  const romanianCities = [
    'Bucharest', 'București', 'Cluj-Napoca', 'Cluj Napoca',
    'Timișoara', 'Timisoara', 'Iași', 'Iasi', 'Brașov', 'Brasov',
    'Constanța', 'Constanta', 'Craiova', 'Bacău', 'Sibiu',
    'Târgu Mureș', 'Targu Mures', 'Oradea', 'Baia Mare', 'Satu Mare',
    'Ploiești', 'Ploiesti', 'Pitești', 'Pitesti', 'Arad', 'Galați', 'Galati',
    'Brăila', 'Braila', 'Drobeta-Turnu Severin', 'Râmnicu Vâlcea', 'Ramnicu Valcea',
    'Buzău', 'Buzau', 'Botoșani', 'Botosani', 'Zalău', 'Zalau', 'Hunedoara', 'Deva',
    'Suceava', 'Bistrița', 'Bistrita', 'Tulcea', 'Călărași', 'Calarasi',
    'Giurgiu', 'Alba Iulia', 'Slatina', 'Piatra Neamț', 'Piatra Neamt', 'Roman',
    'Dumbrăvița', 'Dumbravita', 'Voluntari', 'Popești-Leordeni', 'Popesti-Leordeni',
    'Chitila', 'Mogoșoaia', 'Mogosoaia', 'Otopeni'
  ];

  const citySet = new Set(romanianCities.map(c => c.toLowerCase()));

  const normalizeWorkmode = (wm) => {
    if (!wm) return undefined;
    const lower = wm.toLowerCase();
    if (lower.includes('remote')) return 'remote';
    if (lower.includes('office') || lower.includes('on-site') || lower.includes('site')) return 'on-site';
    return 'hybrid';
  };

  const transformed = {
    ...payload,
    company: payload.company?.toUpperCase(),
    jobs: payload.jobs.map(job => {
      const validLocations = (job.location || []).filter(loc => {
        const lower = loc.toLowerCase().trim();
        if (lower === 'romania' || lower === 'românia') return true;
        return citySet.has(lower);
      }).map(loc => loc.toLowerCase() === 'romania' ? 'România' : loc);

      return {
        ...job,
        location: validLocations.length > 0 ? validLocations : ['România'],
        workmode: normalizeWorkmode(job.workmode)
      };
    })
  };

  return transformed;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const testOnlyOnePage = process.argv.includes("--test");

  try {
    fs.mkdirSync("scraper", { recursive: true });

    console.log("=== Step 1: Get existing jobs from SOLR ===");
    const existingResult = await querySOLR(COMPANY_CIF);
    const existingCount = existingResult.numFound;
    const existingUrls = new Set(existingResult.docs.map(doc => doc.url).filter(Boolean));
    console.log(`Found ${existingCount} existing jobs in SOLR`);

    console.log("=== Step 2: Validate company via ANAF ===");
    const { company, cif, address, status } = await validateAndGetCompany();
    COMPANY_NAME = company;
    if (status === 'inactive') {
      console.log("⚠️ Company is INACTIVE — jobs deleted, skipping scrape.");
      return;
    }

    try {
      await upsertCompany({
        id: cif,
        company,
        brand: companyConfig.brand || undefined,
        status: status === 'active' ? 'activ' : (status || "activ"),
        location: address ? [address] : companyConfig.location,
        website: companyConfig.website,
        career: companyConfig.career,
        lastScraped: new Date().toISOString().split('T')[0]
      });
    } catch (err) {
      console.log(`Note: Could not upsert company: ${err.message}`);
    }

    const rawJobs = await scrapeAllListings(testOnlyOnePage);
    const scrapedCount = rawJobs.length;
    console.log(`Jobs scraped from FREQUENTIS Careers website: ${scrapedCount}`);

    if (!testOnlyOnePage) {
      const anofmJobs = await searchANOFM(cif);
      const anofmCount = anofmJobs.length;
      for (const job of anofmJobs) {
        if (!rawJobs.find(j => j.url === job.url)) {
          rawJobs.push(job);
        }
      }
      console.log(`Jobs added from ANOFM: ${anofmCount}`);
    }

    const jobs = rawJobs.map(job => mapToJobModel(job, cif));

    const payload = {
      source: "www.frequentis.com",
      scrapedAt: new Date().toISOString(),
      company: COMPANY_NAME,
      cif: cif,
      jobs
    };

    console.log("Transforming jobs for SOLR...");
    const transformedPayload = transformJobsForSOLR(payload);
    const validCount = transformedPayload.jobs.filter(j => j.location).length;
    console.log(`Jobs with valid Romanian locations: ${validCount}`);

    fs.writeFileSync("scraper/jobs.json", JSON.stringify(transformedPayload, null, 2), "utf-8");
    console.log("Saved scraper/jobs.json");

    const companyData = {
      id: cif,
      company: transformedPayload.company,
      brand: companyConfig.brand || undefined,
      status: status === 'active' ? 'activ' : (status || "activ"),
      location: address ? [address] : companyConfig.location,
      website: companyConfig.website,
      career: companyConfig.career,
      lastScraped: new Date().toISOString().split('T')[0]
    };
    const markdown = generateJobsMarkdown(companyData, transformedPayload.jobs);
    fs.mkdirSync("docs", { recursive: true });
    fs.writeFileSync("docs/jobs.md", markdown, "utf-8");
    console.log("Saved docs/jobs.md");

    fs.copyFileSync("scraper/config/company.json", "docs/company.json");
    console.log("Copied scraper/config/company.json → docs/company.json");

    console.log("\n=== Step 4: Upsert jobs to SOLR ===");
    await upsertJobs(transformedPayload.jobs);

    const scrapedUrls = new Set(transformedPayload.jobs.map(job => job.url));
    const staleUrls = [...existingUrls].filter(url => !scrapedUrls.has(url));

    if (staleUrls.length > 0) {
      console.log(`\n=== Step 4.5: Delete ${staleUrls.length} stale job(s) ===`);
      let deletedCount = 0;
      for (const url of staleUrls) {
        try {
          console.log(`  Deleting: ${url}`);
          await deleteJobByUrl(url);
          deletedCount++;
        } catch (delErr) {
          console.warn(`  ⚠️ Failed to delete: ${url} — ${delErr.message}`);
        }
      }
      console.log(`✅ Deleted ${deletedCount}/${staleUrls.length} stale job(s)`);
    } else {
      console.log("\n✅ No stale jobs to delete");
    }

    console.log("\n=== Step 5: Summary ===");

    await new Promise(r => setTimeout(r, 2000));
    const finalResult = await querySOLR(COMPANY_CIF);
    console.log(`\n=== SUMMARY ===`);
    console.log(`Jobs existing in SOLR before scrape: ${existingCount}`);
    console.log(`Jobs scraped from FREQUENTIS website: ${scrapedCount}`);
    console.log(`Stale jobs attempted: ${staleUrls.length}`);
    console.log(`Jobs in SOLR after scrape: ${finalResult.numFound}`);
    console.log(`====================`);

    console.log("\n=== DONE ===");
    console.log("Scraper completed successfully!");

  } catch (err) {
    console.error("Scraper failed:", err);
    process.exit(1);
  }
}

export { parseJobListing, fetchJobDetails, isRomanianJob, detectWorkmode, extractTags, mapToJobModel, transformJobsForSOLR };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
