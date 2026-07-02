import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_DIR = 'store/idempotency';

/**
 * Idempotency via atomic per-event claim files (PHASE3_PROCESS_DESIGN.md, Tầng 2b). Replaces
 * the old check-then-mark single-JSON-file design, which had a real TOCTOU gap: two callers
 * could both read "not processed" before either wrote "processed" — the exact mechanism behind
 * the SPLIT_REPORT.md §5 incident (a leaked process fired a rule the current process thought
 * was disabled, on the same live event). `tryClaim` collapses check+mark into ONE atomic
 * filesystem syscall (`O_CREAT|O_EXCL` via the `fs` `'wx'` flag) — the OS itself arbitrates
 * which caller wins, with no gap between "check" and "act" for either.
 */
export class IdempotencyLog {
  constructor(private readonly dir: string = DEFAULT_DIR) {}

  isProcessed(transferId: string): boolean {
    return existsSync(this.pathFor(transferId));
  }

  /** Atomically claims transferId. Returns true iff THIS call won the claim. */
  async tryClaim(transferId: string): Promise<boolean> {
    await mkdir(this.dir, { recursive: true });
    try {
      await writeFile(this.pathFor(transferId), JSON.stringify({ claimedAt: Date.now() }), { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  }

  private pathFor(transferId: string): string {
    return join(this.dir, `${transferId}.json`);
  }
}
