import { randomUUID } from 'node:crypto';
import { readJsonIfExists, writeJson } from '../util/json-file.js';
import type { Rule, RuleAction, RuleGuards, RuleTrigger } from './types.js';

const DEFAULT_RULES_PATH = 'store/rules.json';

export interface NewRuleInput {
  readonly enabled: boolean;
  readonly trigger: RuleTrigger;
  readonly action: RuleAction;
  readonly guards: RuleGuards;
}

/** Rule Store (CLAUDE.md 4.5): rules + their state persisted to a JSON file, loaded at startup. */
export class RuleStore {
  private rules: Rule[];

  constructor(
    rules: Rule[],
    private readonly path: string = DEFAULT_RULES_PATH,
  ) {
    this.rules = rules;
  }

  static async load(path: string = DEFAULT_RULES_PATH): Promise<RuleStore> {
    const data = await readJsonIfExists<Rule[]>(path);
    return new RuleStore(data ?? [], path);
  }

  list(): readonly Rule[] {
    return this.rules;
  }

  get(id: string): Rule | undefined {
    return this.rules.find((r) => r.id === id);
  }

  async add(input: NewRuleInput): Promise<Rule> {
    const rule: Rule = { id: randomUUID(), ...input, state: { fireCount: 0 } };
    this.rules.push(rule);
    await this.save();
    return rule;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const rule = this.get(id);
    if (!rule) throw new Error(`Rule not found: ${id}`);
    rule.enabled = enabled;
    await this.save();
  }

  async remove(id: string): Promise<void> {
    this.rules = this.rules.filter((r) => r.id !== id);
    await this.save();
  }

  /** Persist state mutations (fireCount, lastFiredAt, rate-limit window) after processing an event. */
  async saveState(): Promise<void> {
    await this.save();
  }

  private async save(): Promise<void> {
    await writeJson(this.path, this.rules);
  }
}
