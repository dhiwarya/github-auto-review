import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Db } from '../src/db.ts';
import { startServer } from '../src/server/app.ts';
import { SettingsStore } from '../src/settings.ts';
import type { HistoryPage, Job } from '../src/types.ts';

describe('the queue history, one page at a time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-history-'));
  const db = new Db(dir);
  let app: Awaited<ReturnType<typeof startServer>>;
  let base = '';
  const get = async <T>(url: string) => (await fetch(`${base}${url}`)).json() as Promise<T>;

  before(async () => {
    // 30 finished reviews and 2 waiting in the queue.
    for (let i = 1; i <= 32; i++) {
      const job = db.insertJob({
        repo: 'acme/api', pr_number: i, pr_title: `PR ${i}`, pr_url: 'u', author: 'a', head_sha: `${i}`.padStart(40, '0'), base_sha: 'b', since_sha: null,
        mode: 'publish', source: 'request', dry_run: 0, state: 'queued', additions: 1, deletions: 0, changed_files: 1,
      });
      if (i <= 30) db.setState(job.id, 'done', { review_body: 'x'.repeat(5000), review_state: 'COMMENTED' });
    }
    const deps = { cfg: new SettingsStore(db), host: '127.0.0.1', allowedHosts: [], port: 0, db } as unknown as Parameters<typeof startServer>[0];
    app = await startServer(deps);
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await app.close();
    db.sql.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pages finished jobs newest first, and counts them all', async () => {
    const first = await get<HistoryPage>('/api/history?page=1&size=25');
    assert.equal(first.total, 30);
    assert.deepEqual(first.jobs.map((j) => j.pr_number).slice(0, 3), [30, 29, 28]);
    assert.equal(first.jobs.length, 25);
    const second = await get<HistoryPage>('/api/history?page=2&size=25');
    assert.deepEqual(second.jobs.map((j) => j.pr_number), [5, 4, 3, 2, 1]);
    assert.equal((await get<HistoryPage>('/api/history?page=9&size=25')).page, 2, 'past the end shows the last page');
    assert.equal((await get<HistoryPage>('/api/history?page=x&size=0')).size, 25, 'nonsense falls back to the defaults');
  });

  it('leaves the long review text out of lists', async () => {
    const page = await get<HistoryPage>('/api/history');
    assert.equal(page.jobs[0].review_body, null);
    assert.equal('review_policy' in page.jobs[0], false);
    assert.deepEqual(page.jobs[0].counts, { blocker: 0, major: 0, minor: 0, nit: 0 });
  });

  it('lists only the active jobs when asked', async () => {
    const active = await get<Job[]>('/api/jobs?active=1');
    assert.deepEqual(active.map((j) => [j.pr_number, j.state]), [[32, 'queued'], [31, 'queued']]);
  });
});
