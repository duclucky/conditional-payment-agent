import type { IncomingTransfer } from '@unicitylabs/sphere-sdk';

export interface CoinTotal {
  readonly coinId: string;
  readonly symbol: string;
  readonly totalAmount: bigint;
}

/**
 * IncomingTransfer carries no top-level amount/coinId — sum tokens[] per coinId in base units.
 * BigInt throughout: these are wallet balances, never floats (CLAUDE.md 4.2 #1/#2).
 */
export function sumIncomingByCoin(transfer: IncomingTransfer): CoinTotal[] {
  const totals = new Map<string, { symbol: string; totalAmount: bigint }>();
  for (const token of transfer.tokens) {
    const existing = totals.get(token.coinId);
    const amount = BigInt(token.amount);
    if (existing) {
      existing.totalAmount += amount;
    } else {
      totals.set(token.coinId, { symbol: token.symbol, totalAmount: amount });
    }
  }
  return [...totals.entries()].map(([coinId, v]) => ({ coinId, symbol: v.symbol, totalAmount: v.totalAmount }));
}

export function formatCoinTotals(totals: CoinTotal[]): string {
  if (totals.length === 0) return '(no tokens)';
  return totals.map((t) => `${t.totalAmount} ${t.symbol} (coinId ${t.coinId.slice(0, 12)}…)`).join(', ');
}
