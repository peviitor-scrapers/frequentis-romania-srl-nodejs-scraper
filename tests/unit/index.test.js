import { jest } from '@jest/globals';

describe('index.js Component Tests', () => {
  let index;

  beforeAll(async () => {
    index = await import('../../scraper/index.js');
  });

  describe('transformJobsForSOLR', () => {
    it('should filter locations to only Romanian cities', () => {
      const payload = {
        jobs: [
          { url: 'https://test.com/1', title: 'Job 1', location: ['România'] },
          { url: 'https://test.com/2', title: 'Job 2', location: ['Bucharest'] },
          { url: 'https://test.com/3', title: 'Job 3', location: ['Bulgaria'] },
          { url: 'https://test.com/4', title: 'Job 4', location: ['Cluj-Napoca'] },
          { url: 'https://test.com/5', title: 'Job 5', location: [] }
        ]
      };

      const result = index.transformJobsForSOLR(payload);

      expect(result.jobs[0].location).toEqual(['România']);
      expect(result.jobs[1].location).toEqual(['Bucharest']);
      expect(result.jobs[2].location).toEqual(['România']);
      expect(result.jobs[3].location).toEqual(['Cluj-Napoca']);
      expect(result.jobs[4].location).toEqual(['România']);
    });

    it('should keep company uppercase', () => {
      const payload = {
        source: 'www.frequentis.com',
        company: 'frequentis romania srl',
        cif: '25475641',
        jobs: [
          { url: 'https://test.com/1', title: 'Job 1', company: 'frequentis', cif: '25475641' }
        ]
      };

      const result = index.transformJobsForSOLR(payload);

      expect(result.company).toBe('FREQUENTIS ROMANIA SRL');
    });

    it('should normalize workmode values', () => {
      const payload = {
        jobs: [
          { url: 'https://test.com/1', title: 'Job 1', workmode: 'Remote' },
          { url: 'https://test.com/2', title: 'Job 2', workmode: 'ON-SITE' },
          { url: 'https://test.com/3', title: 'Job 3', workmode: 'Hybrid' },
          { url: 'https://test.com/4', title: 'Job 4', workmode: 'hybrid' }
        ]
      };

      const result = index.transformJobsForSOLR(payload);

      expect(result.jobs[0].workmode).toBe('remote');
      expect(result.jobs[1].workmode).toBe('on-site');
      expect(result.jobs[2].workmode).toBe('hybrid');
      expect(result.jobs[3].workmode).toBe('hybrid');
    });

    it('should handle empty jobs array', () => {
      const result = index.transformJobsForSOLR({ jobs: [] });
      expect(result.jobs).toEqual([]);
    });
  });

  describe('mapToJobModel', () => {
    it('should map raw job to job model format', () => {
      const rawJob = {
        url: 'https://jobs.frequentis.com/job/123',
        title: 'Senior Developer',
        location: ['Bucharest'],
        tags: ['Java', 'Spring'],
        workmode: 'hybrid'
      };

      const COMPANY_NAME = 'FREQUENTIS ROMANIA SRL';
      const COMPANY_CIF = '25475641';

      const result = index.mapToJobModel(rawJob, COMPANY_CIF, COMPANY_NAME);

      expect(result.url).toBe(rawJob.url);
      expect(result.title).toBe(rawJob.title);
      expect(result.company).toBe(COMPANY_NAME);
      expect(result.cif).toBe(COMPANY_CIF);
      expect(result.location).toEqual(rawJob.location);
      expect(result.tags).toEqual(rawJob.tags);
      expect(result.workmode).toBe(rawJob.workmode);
      expect(result.status).toBe('scraped');
      expect(result.date).toBeDefined();
    });

    it('should remove undefined fields', () => {
      const rawJob = {
        url: 'https://test.com/1',
        title: 'Job 1'
      };

      const result = index.mapToJobModel(rawJob, '25475641');

      expect(result.location).toBeUndefined();
      expect(result.tags).toBeUndefined();
      expect(result.workmode).toBeUndefined();
    });

    it('should handle missing title', () => {
      const rawJob = { url: 'https://test.com/1' };

      const result = index.mapToJobModel(rawJob, '25475641');

      expect(result.title).toBeUndefined();
      expect(result.url).toBe('https://test.com/1');
    });
  });

  describe('parseJobListing', () => {
    const item = (href, title, subtitle) => `
      <div class="list__item__detail">
        <div class="list__item__text">
          <div class="list__item__text__title"><a href="${href}">${title}</a></div>
          <div class="list__item__text__subtitle collapaseIcon">${subtitle}</div>
        </div>
      </div>`;

    it('should parse Romanian jobs from listing HTML', () => {
      const html = item(
        'https://jobs.frequentis.com/careers/JobDetail/ROU-DevOps-Engineer-MosaiX/3319',
        'DevOps Engineer - MosaiX',
        'Air Traffic Management | Romania | Cluj-Napoca, Cluj | FREQUENTIS Romania SRL'
      );

      const jobs = index.parseJobListing(html);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].title).toBe('DevOps Engineer - MosaiX');
      expect(jobs[0].url).toBe('https://jobs.frequentis.com/careers/JobDetail/ROU-DevOps-Engineer-MosaiX/3319');
      expect(jobs[0].place).toBe('Cluj-Napoca');
    });

    it('should skip jobs outside Romania', () => {
      const html = item(
        'https://jobs.frequentis.com/careers/JobDetail/FUSA-Financial-Analyst/3670',
        'Financial Analyst',
        'United States | Maryland, Columbia | FREQUENTIS USA, Inc.'
      );

      expect(index.parseJobListing(html)).toEqual([]);
    });

    it('should resolve relative URLs against the careers site', () => {
      const html = item('/careers/JobDetail/ROU-Test/1', 'Test', 'IT | Romania | Cluj-Napoca, Cluj | FREQUENTIS Romania SRL');

      expect(index.parseJobListing(html)[0].url).toBe('https://jobs.frequentis.com/careers/JobDetail/ROU-Test/1');
    });

    it('should handle empty HTML', () => {
      expect(index.parseJobListing('')).toEqual([]);
    });
  });

  describe('isRomanianJob', () => {
    it('should detect Romania by URL prefix or subtitle', () => {
      expect(index.isRomanianJob('https://x/JobDetail/ROU-Dev/1', '')).toBe(true);
      expect(index.isRomanianJob('https://x/JobDetail/FCO-Dev/1', 'IT | Romania | Cluj')).toBe(true);
      expect(index.isRomanianJob('https://x/JobDetail/FCO-Dev/1', 'IT | Germany')).toBe(false);
    });
  });

  describe('detectWorkmode / extractTags', () => {
    it('should detect workmode from text', () => {
      expect(index.detectWorkmode('This is a hybrid role')).toBe('hybrid');
      expect(index.detectWorkmode('Fully remote position')).toBe('remote');
      expect(index.detectWorkmode('Office based')).toBe('on-site');
    });

    it('should extract known technology tags', () => {
      expect(index.extractTags('Experience with Java, Linux and Docker')).toEqual(['java', 'docker', 'linux']);
      expect(index.extractTags('No relevant skills')).toEqual([]);
    });
  });
});
