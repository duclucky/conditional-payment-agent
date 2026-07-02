import type { IdentityResolverPort } from './types.js';

/** Minimal slice of Sphere this needs — real Sphere satisfies it structurally. */
export interface ResolveCapable {
  resolve(identifier: string): Promise<{ chainPubkey: string } | null>;
}

/**
 * Resolves a nametag/address to its chainPubkey, caching hits for the process lifetime.
 * Safe to cache indefinitely: Unicity nametag bindings are first-seen-wins and effectively
 * static once registered (README) — the only miss we don't want to cache is "not found",
 * since propagation delay means a not-yet-resolvable nametag might resolve moments later.
 */
export class IdentityResolver implements IdentityResolverPort {
  private readonly cache = new Map<string, string>();

  constructor(private readonly sphere: ResolveCapable) {}

  async resolveChainPubkey(identifier: string): Promise<string | null> {
    const key = identifier.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const peer = await this.sphere.resolve(identifier);
    if (!peer) return null;

    this.cache.set(key, peer.chainPubkey);
    return peer.chainPubkey;
  }
}
