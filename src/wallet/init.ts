import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createOwnStorageWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';
import type { AppConfig } from '../config.js';
import { log } from '../logger.js';
import { readJsonIfExists, readOrCreateJson, writeJson } from '../util/json-file.js';
import { acquireProcessLock } from './process-lock.js';

interface LocalIdentityConfig {
  deviceId: string;
  nametag: string;
}

export interface WalletRole {
  /** Short role name — used for directory naming + logs (e.g. 'agent', 'counterparty'). */
  readonly name: string;
  /** Nametag prefix; a random suffix is generated once and persisted alongside the wallet. */
  readonly nametagPrefix: string;
  /** When set, register EXACTLY this nametag instead of ensureNametag's random-candidate flow —
   * used for branded destination wallets (scripts/create-destination.ts). Never falls back to a
   * different name on collision; the caller must pick one that's free. */
  readonly exactNametag?: string;
}

export interface WalletHandle {
  readonly sphere: Sphere;
  readonly created: boolean;
  readonly generatedMnemonic?: string;
  readonly nametag: string | undefined;
  readonly deviceId: string;
  readonly dataDir: string;
  readonly tokensDir: string;
  /** Releases the process lock early. Rarely needed explicitly — a safety-net `process.on('exit')`
   * handler already releases it on normal termination (see process-lock.ts). */
  readonly release: () => void;
}

const NAMETAG_REGISTER_ATTEMPTS = 3;
// Unicity ID format (README): lowercase alphanumeric with _ or -, 3-20 chars total.
const NAMETAG_PATTERN = /^[a-z0-9_-]{3,20}$/;
const NAMETAG_SUFFIX_BYTES = 3; // 6 hex chars — keeps prefixes up to 13 chars within the 20-char cap
const ROLE_NAME_PATTERN = /^[a-z][a-z0-9-]{1,20}$/;

/**
 * Validate a role name coming from a CLI argument before it's used to build a filesystem path
 * (`data/<role>`, `tokens/<role>`) — rejects anything that isn't a short lowercase slug so a
 * typo or stray argument can't traverse outside those directories.
 */
export function parseRoleArg(value: string | undefined, usage: string): string {
  if (!value || !ROLE_NAME_PATTERN.test(value)) {
    throw new Error(`${usage}\nGot role: "${value ?? ''}" — must match ${ROLE_NAME_PATTERN} (e.g. "agent", "counterparty", "partner").`);
  }
  return value;
}

/**
 * Validate a user-chosen nametag (e.g. for scripts/create-destination.ts) before it's used both
 * as a network nametag AND as a `data/<nametag>` / `tokens/<nametag>` directory segment. Reuses
 * the same pattern already enforced for auto-generated candidates (README: Unicity IDs are
 * lowercase alphanumeric with _ or -, 3-20 chars) — anchored, so a passing value can never
 * contain '/' or '..' and is safe as a path segment too.
 */
export function validateNametagFormat(nametag: string): void {
  if (!NAMETAG_PATTERN.test(nametag)) {
    throw new Error(
      `"${nametag}" is not a valid Unicity nametag — must be lowercase alphanumeric with _ or -, ` +
        `3-20 chars total (got ${nametag.length} chars).`,
    );
  }
}

function generateNametagCandidate(prefix: string): string {
  const candidate = `${prefix}-${randomBytes(NAMETAG_SUFFIX_BYTES).toString('hex')}`;
  if (!NAMETAG_PATTERN.test(candidate)) {
    throw new Error(
      `Generated nametag "${candidate}" (${candidate.length} chars) is invalid — Unicity IDs must be ` +
        `lowercase alphanumeric/underscore/hyphen, 3-20 chars total. Shorten the nametag prefix ` +
        `(currently "${prefix}", ${prefix.length} chars — must be <= 13 to leave room for "-XXXXXX") in .env.`,
    );
  }
  return candidate;
}

/**
 * Register `local.nametag` on `sphere`, retrying with a fresh candidate if taken.
 * Checks availability first (README-documented pattern) instead of relying on Sphere.init's
 * internal nametag-conflict behavior, which the installed .d.ts does not fully specify.
 */
async function ensureNametag(
  sphere: Sphere,
  local: LocalIdentityConfig,
  identityPath: string,
  roleName: string,
  nametagPrefix: string,
): Promise<string | undefined> {
  const existing = sphere.identity?.nametag;
  if (existing) return existing;

  let candidate = local.nametag;
  for (let attempt = 1; attempt <= NAMETAG_REGISTER_ATTEMPTS; attempt++) {
    const available = await sphere.isNametagAvailable(candidate);
    if (available) {
      await sphere.registerNametag(candidate);
      if (candidate !== local.nametag) {
        await writeJson<LocalIdentityConfig>(identityPath, { ...local, nametag: candidate });
      }
      return candidate;
    }
    log.warn(roleName, `nametag "${candidate}" already taken on testnet2, trying another`);
    // Regenerate fresh from the prefix (not append-onto-candidate) so retries can never
    // drift past the 20-char cap.
    candidate = generateNametagCandidate(nametagPrefix);
  }
  log.error(roleName, `could not register a nametag after ${NAMETAG_REGISTER_ATTEMPTS} attempts — continuing without one (DIRECT:// address still works)`);
  return undefined;
}

/**
 * Register a SPECIFIC nametag rather than a randomly generated one, used for branded destination
 * wallets (scripts/create-destination.ts). Unlike `ensureNametag`, this NEVER substitutes a
 * different candidate on collision — the entire point is registering the exact requested name, so
 * a collision must stop and be reported, never silently swapped for something else.
 */
async function registerExactNametag(sphere: Sphere, nametag: string, roleName: string): Promise<string> {
  const existing = sphere.identity?.nametag;
  if (existing === nametag) return existing; // idempotent re-run of this same script
  if (existing) {
    throw new Error(`Wallet already has nametag "@${existing}" registered — cannot also register "@${nametag}" (one wallet, one nametag).`);
  }
  const available = await sphere.isNametagAvailable(nametag);
  if (!available) {
    throw new Error(`Nametag "@${nametag}" is already taken on testnet2 — choose a different one. Refusing to overwrite someone else's registration.`);
  }
  await sphere.registerNametag(nametag);
  log.info(roleName, `registered nametag "@${nametag}"`);
  return nametag;
}

/**
 * Resolve-only counterpart to `ensureNametag`, used when the wallet was restored from an existing
 * mnemonic (AGENT_MNEMONIC) rather than auto-generated. Verified empirically (2026-07, disposable
 * test wallet): after `Sphere.init({ mnemonic, ... })`, `sphere.identity.nametag` already comes
 * back populated with the previously-registered nametag for that identity — no extra option
 * needed. This function NEVER falls through to generating/registering a new nametag: an existing
 * branded identity must not get a second nametag squatted on top of it just because resolution
 * was momentarily unavailable (e.g. Nostr relay lag). If nothing resolves, it logs loudly and
 * returns undefined — the wallet still works via its DIRECT:// address.
 */
function resolveExistingNametag(sphere: Sphere, roleName: string): string | undefined {
  const nametag = sphere.identity?.nametag;
  if (nametag) return nametag;
  log.error(
    roleName,
    'AGENT_MNEMONIC was provided but no nametag resolved for this identity — continuing with the ' +
      'DIRECT:// address only. If this wallet is expected to already have a registered nametag, ' +
      'double-check the mnemonic and Nostr relay propagation. This will NOT auto-register a new ' +
      'nametag on top of an existing identity.',
  );
  return undefined;
}

export async function initWallet(role: WalletRole, config: AppConfig): Promise<WalletHandle> {
  const dataDir = join('data', role.name);
  const tokensDir = join('tokens', role.name);
  const identityPath = join(dataDir, 'local-identity.json');

  // Acquire the wallet-exclusivity lock FIRST — fail fast before any network round-trip if
  // another process already holds this wallet (PHASE3_PROCESS_DESIGN.md, Tầng 1).
  const lock = acquireProcessLock(join(dataDir, 'agent.lock'), role.name);

  const local = await readOrCreateJson<LocalIdentityConfig>(identityPath, () => ({
    deviceId: randomUUID(),
    nametag: generateNametagCandidate(role.nametagPrefix),
  }));

  const base = createNodeProviders({
    network: 'testnet2',
    dataDir,
    tokensDir,
    oracle: { apiKey: config.oracleApiKey },
  });

  const { delivery, walletApi } = createOwnStorageWalletApiProviders(base, {
    baseUrl: config.walletApiBaseUrl,
    network: 'testnet2',
    deviceId: local.deviceId,
  });

  // Only the 'agent' role can load from an existing mnemonic — counterparty/partner are always
  // disposable local test wallets (CLAUDE.md scope) and always autoGenerate.
  const useExistingMnemonic = role.name === 'agent' && !!config.agentMnemonic;

  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...base,
    delivery,
    walletApi,
    ...(useExistingMnemonic ? { mnemonic: config.agentMnemonic } : { autoGenerate: true }),
    // Despite the .d.ts marking this "informational only" (config comes from provider URLs),
    // Sphere.init throws SphereError('network is required to configure the TokenRegistry')
    // at runtime without it — confirmed by actually running this, not by reading types alone.
    network: 'testnet2',
  });

  if (useExistingMnemonic) {
    log.info(role.name, 'loaded existing wallet from AGENT_MNEMONIC (not a new wallet)');
  } else if (created && generatedMnemonic) {
    log.warn(role.name, '=== NEW WALLET CREATED — SAVE THIS RECOVERY PHRASE NOW (shown once) ===');
    log.warn(role.name, generatedMnemonic);
  }

  const nametag = useExistingMnemonic
    ? resolveExistingNametag(sphere, role.name)
    : role.exactNametag
      ? await registerExactNametag(sphere, role.exactNametag, role.name)
      : await ensureNametag(sphere, local, identityPath, role.name, role.nametagPrefix);

  if (useExistingMnemonic) {
    log.info(
      role.name,
      `resolved identity: nametag=${nametag ? '@' + nametag : '(none)'} directAddress=${sphere.identity?.directAddress ?? '(unknown)'} chainPubkey=${sphere.identity?.chainPubkey ?? '(unknown)'}`,
    );
  }

  return { sphere, created, generatedMnemonic, nametag, deviceId: local.deviceId, dataDir, tokensDir, release: lock.release };
}

/**
 * Read another role's registered nametag from its local-identity.json without initializing
 * its wallet — lets Phase 1 test scripts find each other's nametag on the same machine
 * instead of requiring manual copy-paste through .env between runs.
 */
export async function peekNametag(roleName: string): Promise<string | undefined> {
  const local = await readJsonIfExists<LocalIdentityConfig>(join('data', roleName, 'local-identity.json'));
  return local?.nametag;
}
