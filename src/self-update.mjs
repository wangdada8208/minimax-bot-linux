// @ts-check
/**
 * Self-update for the page's update button.
 *
 * The host checks out its own repository, so updating is a fast-forward of that
 * checkout. `scripts/self-update.sh` owns the policy — it refuses a dirty tree,
 * a diverged branch, a detached HEAD and any local commit — and this module only
 * runs it, keeps its answer, and reports whether a restart is still pending.
 *
 * Nothing here touches the running process: an update lands on disk and the
 * page tells the operator to restart, so the swap never happens under a live turn.
 */
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';

/** How long a check or an apply may take before it is reported as unavailable. */
const CHECK_TIMEOUT_MS = 30_000;
const APPLY_TIMEOUT_MS = 120_000;

export class SelfUpdate {
  /** @param {{ root: string, logger?: { warn: (...args: any[]) => void } }} options */
  constructor(options) {
    this.root = options.root;
    this.logger = options.logger ?? console;
    this.script = path.join(this.root, 'scripts/self-update.sh');
    // The commit this process actually booted with. The checkout can move ahead
    // while the process keeps running the old code, so the page must compare
    // against this, not the current HEAD on disk.
    this.launchedCommit = readHead(this.root);
    /** @type {{ from: string, to: string } | undefined} */
    this.pending = undefined;
    /** @type {Promise<any> | undefined} */
    this.inFlight = undefined;
  }

  /**
   * @param {'check' | 'apply'} mode
   * @returns {Promise<any>}
   */
  #run(mode) {
    return new Promise((resolve) => {
      execFile(
        'bash',
        [this.script, mode],
        { cwd: this.root, timeout: mode === 'apply' ? APPLY_TIMEOUT_MS : CHECK_TIMEOUT_MS },
        (error, stdout, stderr) => {
          const line = String(stdout).trim().split('\n').filter(Boolean).at(-1);
          if (line) {
            try {
              resolve(JSON.parse(line));
              return;
            } catch {
              // fall through to the error shape below
            }
          }
          this.logger.warn(`self_update.${mode}_failed ${String(stderr || error?.message || '').slice(0, 400)}`);
          resolve({ ok: false, reason: 'The update script did not answer.' });
        },
      );
    });
  }

  /**
   * The running commit, whether an update exists, and whether applying is safe.
   * A checkout that already moved ahead of the running process still needs a
   * restart, so that is reported even when nothing new is left to fetch.
   */
  async check() {
    const result = await this.#run('check');
    const disk = result.current ?? readHead(this.root);
    const restartRequired = Boolean(this.pending) || (Boolean(disk) && disk !== this.launchedCommit);
    return { ...result, running: this.launchedCommit, disk, restartRequired };
  }

  /**
   * Fast-forward the checkout. Serialised: a second click joins the first run
   * instead of starting a competing fetch.
   */
  async apply() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const result = await this.#run('apply');
        if (result.ok && result.changed) {
          this.pending = { from: String(result.from ?? ''), to: String(result.to ?? '') };
        }
        const disk = result.to ?? result.current ?? readHead(this.root);
        const restartRequired = Boolean(this.pending) || (Boolean(disk) && disk !== this.launchedCommit);
        return { ...result, running: this.launchedCommit, disk, restartRequired };
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  /** True once an update has landed on disk but the process still runs the old code. */
  get restartRequired() {
    return Boolean(this.pending);
  }
}

/** The checkout's HEAD, or '' when it cannot be read. */
function readHead(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
