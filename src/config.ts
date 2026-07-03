import 'dotenv/config';

export interface AppConfig {
  readonly network: string;
  readonly oracleApiKey: string;
  readonly walletApiBaseUrl: string;
  readonly dashboardPort: number;
  readonly dashboardHost: string;
  /** BIP39 mnemonic for an EXISTING agent wallet (branded nametag + real tokens). Optional —
   * when absent, the agent wallet auto-generates a brand-new mnemonic as before. Only ever
   * applies to the 'agent' role (see src/wallet/init.ts) — never commit a real value. */
  readonly agentMnemonic: string | undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required .env value: ${name} (see .env.example)`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    network: process.env.NETWORK ?? 'testnet2',
    oracleApiKey: requireEnv('ORACLE_API_KEY'),
    walletApiBaseUrl: requireEnv('WALLET_API_BASE_URL'),
    // Defaults to loopback-only — safe for local dev. Public "live, reviewable" deployment
    // (CLAUDE.md mục 8/9) means either setting DASHBOARD_HOST=0.0.0.0 behind a firewalled
    // VPS/reverse-proxy, or fronting the loopback port with a tunnel — an infra decision left
    // to the user, not guessed at here (see PHASE4_REPORT.md TODOs).
    dashboardPort: Number(process.env.DASHBOARD_PORT) || 8787,
    dashboardHost: process.env.DASHBOARD_HOST ?? '127.0.0.1',
    agentMnemonic: (() => {
      const raw = process.env.AGENT_MNEMONIC?.trim();
      return raw ? raw : undefined;
    })(),
  };
}

/**
 * Nametag prefix for a wallet role, e.g. 'agent' -> 'cpa-agent'. Override per-role via
 * `<ROLE>_NAMETAG_PREFIX` in .env. Falls back to `cpa-<role>`, truncated to fit the 13-char
 * cap that leaves room for the "-XXXXXX" random suffix under the 20-char Unicity ID limit.
 */
export function nametagPrefixForRole(role: string): string {
  const fromEnv = process.env[`${role.toUpperCase()}_NAMETAG_PREFIX`];
  if (fromEnv) return fromEnv;
  const fallback = `cpa-${role}`;
  return fallback.length <= 13 ? fallback : fallback.slice(0, 13);
}
