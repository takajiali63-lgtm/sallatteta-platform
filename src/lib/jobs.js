// Background jobs that are safe with any number of server instances.
// One lease row per job in `job_runs`: an instance runs a job only after atomically taking its lease,
// so a job never runs twice at once and runs once per interval across all instances.
// A crashed instance's lease simply expires and another instance takes over.
// Jobs must be idempotent (all current jobs are).
import { randomBytes } from 'node:crypto';

export function createJobRunner({ db, jobs = [], log = console, instanceId = randomBytes(4).toString('hex'), tickMs = 30_000 }) {
  let timer = null;
  let inflight = null;

  async function ensureRows() {
    for (const j of jobs) await db.query('INSERT INTO job_runs (name, locked_until) VALUES ($1, 0) ON CONFLICT (name) DO NOTHING', [j.name]);
  }

  async function record(job, started, result, err) {
    const now = Date.now();
    if (err) {
      await db.query(
        `UPDATE job_runs SET last_finished_at = $1, last_status = 'error', last_error = $2, failures = failures + 1, locked_until = $3
         WHERE name = $4`,
        [now, String(err.message || err).slice(0, 500), now + (job.retryMs ?? 60_000), job.name]).catch(() => {});
      log.error?.(`[job] ${job.name} failed: ${err.message || err}`);
    } else {
      await db.query(
        `UPDATE job_runs SET last_finished_at = $1, last_status = 'ok', last_error = NULL, last_result = $2, locked_until = $3
         WHERE name = $4`,
        [now, result === undefined ? null : JSON.stringify(result).slice(0, 1000), started + job.everyMs, job.name]);
      if (result && typeof result === 'object' && Object.values(result).some((v) => v)) log.info?.(`[job] ${job.name} ${JSON.stringify(result)}`);
    }
  }

  async function execute(job, started) {
    try {
      const timeout = job.timeoutMs || Math.max(job.everyMs, 60_000);
      const result = await Promise.race([
        job.run(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('job timeout')), timeout).unref?.()),
      ]);
      await record(job, started, result);
      return result;
    } catch (err) {
      await record(job, started, undefined, err);
      return undefined;
    }
  }

  /** Try to take the lease of a due job; run it if we got it. */
  async function runIfDue(job) {
    const now = Date.now();
    const got = await db.query(
      `UPDATE job_runs SET locked_until = $1, locked_by = $2, last_started_at = $3, runs = runs + 1
       WHERE name = $4 AND locked_until <= $3 RETURNING name`,
      [now + (job.timeoutMs || Math.max(job.everyMs, 60_000)), instanceId, now, job.name]);
    if (!got.length) return false;
    await execute(job, now);
    return true;
  }

  async function tick() {
    if (inflight) return inflight;
    inflight = (async () => {
      for (const j of jobs) await runIfDue(j).catch((e) => log.error?.(`[job] ${j.name}: ${e.message}`));
    })();
    try { await inflight; } finally { inflight = null; }
  }

  return {
    instanceId,
    tick,
    async start({ immediate = true } = {}) {
      await ensureRows();
      if (immediate) await tick();
      timer = setInterval(() => { tick(); }, tickMs);
      timer.unref?.();
    },
    async stop() {
      clearInterval(timer);
      timer = null;
      if (inflight) await inflight.catch(() => {});
    },
    /** Run a job right now (admin action / tests), recording its status; still idempotent. */
    async runNow(name) {
      const job = jobs.find((j) => j.name === name);
      if (!job) throw new Error(`unknown job ${name}`);
      await ensureRows();
      const now = Date.now();
      await db.query('UPDATE job_runs SET last_started_at = $1, runs = runs + 1 WHERE name = $2', [now, name]);
      return execute(job, now);
    },
    async status() {
      return db.query('SELECT name, locked_until, locked_by, last_started_at, last_finished_at, last_status, last_error, last_result, runs, failures FROM job_runs ORDER BY name');
    },
  };
}
