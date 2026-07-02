import type { IncomingTransfer, Token, TransferResult } from '@unicitylabs/sphere-sdk';
import type { NewRuleInput } from '../src/rules/store.js';
import type { AgentPort, IdentityResolverPort, Rule } from '../src/rules/types.js';

export function fakeRule(input: NewRuleInput, state?: Partial<Rule['state']>): Rule {
  return { id: `rule-${Math.random().toString(36).slice(2, 8)}`, ...input, state: { fireCount: 0, ...state } };
}

/** IdentityResolverPort stub backed by a plain nametag -> chainPubkey map (no network). */
export function fakeResolver(bindings: Record<string, string>): IdentityResolverPort {
  return {
    resolveChainPubkey: async (identifier: string) => bindings[identifier.toLowerCase()] ?? null,
  };
}

export function fakeToken(coinId: string, symbol: string, amount: string): Token {
  return { id: `tok-${coinId}-${amount}`, coinId, symbol, name: symbol, decimals: 18, amount, status: 'confirmed', createdAt: 0, updatedAt: 0 };
}

export function fakeTransfer(overrides: Partial<IncomingTransfer> & { tokens: Token[] }): IncomingTransfer {
  return { id: 'transfer-1', senderPubkey: 'sender-pubkey', receivedAt: 0, ...overrides };
}

export interface FakeAgent {
  readonly agent: AgentPort;
  readonly sendCalls: Array<{ coinId: string; amount: string; recipient: string; memo?: string }>;
  readonly dmCalls: Array<{ recipient: string; content: string }>;
}

/** In-memory AgentPort stub — records calls instead of touching the network. */
export function createFakeAgent(options?: {
  chainPubkey?: string;
  sendResult?: (call: { coinId: string; amount: string; recipient: string; memo?: string }) => TransferResult;
  sendError?: Error;
}): FakeAgent {
  const sendCalls: FakeAgent['sendCalls'] = [];
  const dmCalls: FakeAgent['dmCalls'] = [];

  const agent: AgentPort = {
    identity: { chainPubkey: options?.chainPubkey ?? 'agent-pubkey' },
    payments: {
      send: async (request) => {
        sendCalls.push(request);
        if (options?.sendError) throw options.sendError;
        if (options?.sendResult) return options.sendResult(request);
        return { id: `fake-tx-${sendCalls.length}`, status: 'completed', tokens: [], tokenTransfers: [] };
      },
      getBalance: () => [],
    },
    communications: {
      sendDM: async (recipient, content) => {
        dmCalls.push({ recipient, content });
        return {};
      },
    },
  };

  return { agent, sendCalls, dmCalls };
}
