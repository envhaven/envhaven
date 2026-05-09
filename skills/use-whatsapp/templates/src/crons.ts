import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Cron } from 'croner';

// User-defined cron jobs. Same persistence pattern as data/allowed-groups.json:
// JSON file re-read on every tick so Claude can mutate it via Edit (in-chat,
// natural language) and the change takes effect within 60s; no restart.
//
// Five fields, none optional. Identity is content; no internal id.
//   jid          chat to reply in (1:1 or allowed group)
//   creatorLid   author's LID, re-checked at fire time so revoking a sender
//                also revokes their crons
//   schedule     5-field cron in CRON_TIMEZONE (passed in by the caller)
//   prompt       what Claude receives when it fires; auto-contained
//   lastRun      ISO of the latest scheduled occurrence already fired,
//                or null on first sight (the scheduler anchors it)

const CRONS_FILE = 'data/crons.json';

export type CronEntry = {
  jid: string;
  creatorLid: string;
  schedule: string;
  prompt: string;
  lastRun: string | null;
};

function loadCrons(): CronEntry[] {
  let raw: string;
  try {
    raw = readFileSync(CRONS_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as CronEntry[]) : [];
}

function saveCrons(crons: CronEntry[]): void {
  mkdirSync(dirname(CRONS_FILE), { recursive: true });
  writeFileSync(CRONS_FILE, JSON.stringify(crons, null, 2));
}

function isValidEntry(e: unknown): e is CronEntry {
  if (typeof e !== 'object' || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.jid === 'string' && r.jid.length > 0 &&
    typeof r.creatorLid === 'string' && r.creatorLid.length > 0 &&
    typeof r.schedule === 'string' && r.schedule.length > 0 &&
    typeof r.prompt === 'string' && r.prompt.length > 0 &&
    (r.lastRun === null || typeof r.lastRun === 'string')
  );
}

// Dedupe schedule-error log lines so a single bad entry doesn't spam the log
// every 60s. Cleared when the schedule string itself changes (new key = new
// warning) so the operator sees a fresh error after they edit it.
const warnedSchedules = new Set<string>();

function parseCron(schedule: string, timezone: string): Cron | null {
  try {
    return new Cron(schedule, { timezone });
  } catch (err) {
    if (!warnedSchedules.has(schedule)) {
      console.error(`[cron] invalid schedule "${schedule}": ${err instanceof Error ? err.message : String(err)}`);
      warnedSchedules.add(schedule);
    }
    return null;
  }
}

type StartArgs = {
  /**
   * IANA timezone name (e.g. "America/Montevideo"). Required; the caller is
   * the right place to resolve env override → system fallback so this module
   * stays free of process.env reads.
   */
  timezone: string;
  /**
   * Called once per due cron, with the canonical fire-time (the latest
   * scheduled occurrence ≤ now after catch-up collapse). Fire-and-forget;
   * the scheduler does not await. The caller is expected to enqueue() the
   * actual work so it serializes with inbound messages on the same JID.
   */
  onDue: (entry: CronEntry, fireAt: Date) => void;
};

export function startCronScheduler({ timezone, onDue }: StartArgs): void {
  const initial = loadCrons();
  console.log(`[cron] scheduler started, ${initial.length} entries loaded, timezone=${timezone}`);

  const runTick = (): void => {
    const now = new Date();
    let crons: CronEntry[];
    try {
      crons = loadCrons();
    } catch (err) {
      console.error('[cron] tick: failed to load crons.json, skipping this tick:', err);
      return;
    }

    let dirty = false;
    for (const entry of crons) {
      if (!isValidEntry(entry)) {
        console.error('[cron] skipping malformed entry:', entry);
        continue;
      }

      // Anchor newly-added entries (lastRun === null) on first sight. Without
      // this, a frequent-schedule cron would never fire: the baseline rolls
      // forward with `now` each tick, so nextRun(now-1s) is always > now.
      // Anchoring also gives Claude an "out": writing lastRun: null at
      // creation is valid and the scheduler stabilizes it.
      if (entry.lastRun === null) {
        entry.lastRun = now.toISOString();
        dirty = true;
        continue;
      }

      const cron = parseCron(entry.schedule, timezone);
      if (!cron) continue;

      let next: Date | null;
      try {
        next = cron.nextRun(new Date(entry.lastRun));
      } catch (err) {
        console.error(`[cron] nextRun failed for "${entry.schedule}":`, err);
        continue;
      }
      if (!next || next > now) continue;

      // Catch-up colapsado: if the bridge was down across N scheduled
      // occurrences, fire ONCE for the latest one and skip the rest. Avoids
      // spam after extended downtime; matches systemd OnCalendar+Persistent
      // semantics. Persist lastRun BEFORE invoking onDue: a crash mid-fire
      // must not double-fire on restart (cron semantics: missed runs stay
      // missed, never replayed).
      let latest = next;
      while (true) {
        let further: Date | null;
        try {
          further = cron.nextRun(latest);
        } catch {
          break;
        }
        if (!further || further > now) break;
        latest = further;
      }
      entry.lastRun = latest.toISOString();
      dirty = true;
      onDue(entry, latest);
    }

    if (dirty) {
      try {
        saveCrons(crons);
      } catch (err) {
        console.error('[cron] tick: failed to persist crons.json (in-memory state diverges until next successful save):', err);
      }
    }
  };

  // Run once immediately so newly-added entries anchor without waiting a full
  // tick, and any catch-up after a restart fires promptly. Then every 60s.
  runTick();
  setInterval(runTick, 60_000);
}
