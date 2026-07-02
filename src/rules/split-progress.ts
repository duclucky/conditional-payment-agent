import { readJsonIfExists, writeJson } from '../util/json-file.js';
import type { SplitLegRecord, SplitProgressPort } from './types.js';

const DEFAULT_PATH = 'store/split-progress.json';

type SplitProgressData = Record<string, Record<number, SplitLegRecord>>;

/**
 * Two-phase per-leg checkpoint for `split` actions (SPLIT_DESIGN_V2.md). Not safe for
 * concurrent writers — same single-process assumption as RuleStore/IdempotencyLog and the
 * wallet's own dataDir (PHASE0_VERIFIED_API.md §3.3: one wallet, one process). The sequential
 * `for...of await` pipeline in RuleEngine never calls this concurrently, so no lock is needed —
 * just don't run two agent processes against the same store/ directory.
 */
export class SplitProgressLog implements SplitProgressPort {
  constructor(
    private readonly data: SplitProgressData,
    private readonly path: string = DEFAULT_PATH,
  ) {}

  static async load(path: string = DEFAULT_PATH): Promise<SplitProgressLog> {
    const data = await readJsonIfExists<SplitProgressData>(path);
    return new SplitProgressLog(data ?? {}, path);
  }

  private key(ruleId: string, executionKey: string): string {
    return `${ruleId}:${executionKey}`;
  }

  getLeg(ruleId: string, executionKey: string, legIndex: number): SplitLegRecord | undefined {
    return this.data[this.key(ruleId, executionKey)]?.[legIndex];
  }

  async markLegSending(ruleId: string, executionKey: string, legIndex: number, info: { to: string; amount: string }): Promise<void> {
    const key = this.key(ruleId, executionKey);
    this.data[key] = { ...this.data[key], [legIndex]: { status: 'sending', to: info.to, amount: info.amount, startedAt: Date.now() } };
    await writeJson(this.path, this.data);
  }

  async markLegSent(ruleId: string, executionKey: string, legIndex: number, transferId: string): Promise<void> {
    const key = this.key(ruleId, executionKey);
    const existing = this.data[key]?.[legIndex];
    this.data[key] = {
      ...this.data[key],
      [legIndex]: { status: 'sent', to: existing?.to ?? '', amount: existing?.amount ?? '0', startedAt: existing?.startedAt ?? Date.now(), transferId, completedAt: Date.now() },
    };
    await writeJson(this.path, this.data);
  }

  async clearLeg(ruleId: string, executionKey: string, legIndex: number): Promise<void> {
    const key = this.key(ruleId, executionKey);
    if (this.data[key]) {
      delete this.data[key][legIndex];
      if (Object.keys(this.data[key]).length === 0) delete this.data[key];
    }
    await writeJson(this.path, this.data);
  }
}
