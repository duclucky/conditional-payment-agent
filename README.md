# Ducky — Autonomous Payment Agent

![Track](https://img.shields.io/badge/Track-01%20Autonomous%20Agents-f5b301)
![Network](https://img.shields.io/badge/Network-Unicity%20Testnet%20v2-388bfd)
![License](https://img.shields.io/badge/License-MIT-3fb950)

**IFTTT for P2P money** — a self-hosted agent that watches for incoming payments on Unicity
Testnet v2 and executes your payment rules autonomously.

This is a **tool you run**, not a dApp you connect a wallet to. It owns its own Sphere wallet,
runs as a background process (on your machine or a server you control), and acts on money moving
in and out of that wallet according to rules you configure — no per-transaction approval, no
browser extension, no third party in the loop.

**Live demo:** http://103.167.88.212:8787 — a real instance of this agent running on testnet2.
Its wallet nametag is `@ducky`. See [How reviewers can test](#how-reviewers-can-test).

---

## What it does

Ducky runs continuously, listening for `transfer:incoming` events and polling its own balance.
When an enabled rule's trigger condition is met, Ducky evaluates guards (rate limits, minimum
amounts, loop protection) and, if they pass, executes the rule's action — forward a percentage
to another wallet, split a payment across several wallets, or send a notification — by calling
the Sphere SDK's `send()` directly.

The agentic property that matters here: Ducky **observes** its own state, **decides** via a
deterministic rule matcher (no LLM anywhere in the money path), and **acts** by itself. A human's
only job is defining the rules and their limits ahead of time.

---

## Architecture & Safety

Money-safety is layered independently of business logic, in `src/wallet/` and `src/rules/`:

- **Process-lock (one wallet, one process)** — `src/wallet/process-lock.ts` writes a PID file per
  wallet directory and verifies liveness by asking the OS directly (`process.kill(pid, 0)`), not
  by trusting whatever tool started the previous process. Two processes touching the same wallet
  is a real corruption mode (a leaked process once fired a rule the live process thought was
  disabled — see `SPLIT_REPORT.md` §5) — this makes it structurally impossible, not just discouraged.
- **Atomic idempotency** — `src/rules/idempotency.ts` claims each incoming transfer with a single
  `fs.writeFile(path, data, { flag: 'wx' })` call (`O_CREAT|O_EXCL`). The OS itself decides which
  caller wins; there is no gap between "check if already processed" and "mark as processed" for
  two callers racing on the same event.
- **`runExclusive` serialization** — `src/rules/engine.ts` funnels every incoming-transfer event
  and every balance-poll tick through one promise queue, so two rule evaluations for the same
  agent state can never interleave — even within a single process, since a `send()` call can take
  10–30 seconds and a second event can easily arrive in that window.
- **Two-phase split checkpointing** — `src/rules/executor.ts`'s `split` action writes a `sending`
  marker before each leg's `send()` call and a `sent` marker after it resolves
  (`src/rules/types.ts`'s `SplitLegRecord`). A crash mid-split resumes without re-paying a leg that
  already landed, and without guessing at one whose outcome is unknown.
- **Outcome-based fail-safe** — a rule is only ever marked as fired based on the resolved/rejected
  outcome of the agent's own `send()` call, never on the SDK's `transfer:failed` event, which can
  fire for an internal retry that later succeeds (confirmed empirically during development —
  see `PHASE2_REPORT.md`).

None of this is specific to forward/split/notify — it's a general substrate for any agent that
must move real money autonomously (see [Roadmap](#roadmap)).

---

## Installation & Setup

### Prerequisites

- Node.js **>= 22**
- npm

### 1. Clone and install

```bash
git clone https://github.com/duclucky/conditional-payment-agent.git
cd conditional-payment-agent
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

`.env.example` ships with every variable the agent reads. Here's what each one does:

| Variable | Required? | What it is |
|---|---|---|
| `ORACLE_API_KEY` | **Required** | Testnet2 gateway API key. The value already in `.env.example` (`sk_ddc3cfcc001e4a28ac3fad7407f99590`) is the **public, intentionally-shared testnet2 key** — safe to use as-is, no signup needed. (A mainnet key would be a real secret; this is not one.) |
| `NETWORK` | Required (has a default) | Must be exactly `testnet2` — it's a server-side storage-key prefix, not just a label. |
| `WALLET_API_BASE_URL` | Required (has a default) | The wallet-api deployment used for delivery (mailbox) and own-storage rails. Default: `https://wallet-api.unicity.network`. |
| `AGENT_NAMETAG_PREFIX` / `COUNTERPARTY_NAMETAG_PREFIX` | Optional | Prefix used when the agent auto-generates a nametag (e.g. `cpa-agent` → `cpa-agent-a1b2c3`). Keep prefixes ≤ 13 characters (Unicity nametags are capped at 20 total, and a random 6-hex-char suffix is appended). Irrelevant if you use `AGENT_MNEMONIC` (below) — a restored wallet keeps its existing nametag. |
| `AGENT_NAMETAG` | Optional | Only read by a couple of ad-hoc Phase 1 test scripts as a fallback nametag to send test transfers to. Not needed for normal operation. |
| `EXTERNAL_TEST_NAMETAG` | Optional | Only used by `scripts/send-external.ts` for manual one-off testing. |
| `AGENT_MNEMONIC` | **Optional** | Restore the agent wallet from an **existing** BIP39 mnemonic instead of generating a brand-new one — use this to run the agent as a wallet that already has a branded nametag and real token balance (this is how the live demo's `@ducky` identity is set up). Leave unset and the agent creates and persists a fresh wallet on first run. **This is a secret.** `.env` is gitignored — never put a real mnemonic in any committed file. Only use a wallet dedicated to this testnet agent; the mnemonic ends up stored in plaintext under `data/agent/wallet.json` on whatever machine runs the agent. |
| `DASHBOARD_PORT` | Optional (default `8787`) | Port for the built-in dashboard (see below). |
| `DASHBOARD_HOST` | Optional (default `127.0.0.1`) | Loopback-only by default. To make the dashboard reachable by a remote reviewer, set this to `0.0.0.0` **behind a firewall or reverse proxy** — the dashboard has no authentication of its own (see `PHASE4_REPORT.md`). |

No manual `mkdir` step is needed: every state directory (`data/`, `tokens/`, `store/`,
`store/idempotency/`) is created automatically on first write.

### 3. Run the agent

```bash
npm run agent
```

On first run this creates the agent's own wallet (or restores it from `AGENT_MNEMONIC`), registers
a nametag if one doesn't already exist, and starts:

- the event-driven Rule Matcher → Guard Check → Action Executor pipeline, plus a balance-polling
  Scheduler (for `onBalanceAbove`/`onBalanceBelow` rules, which have no event to react to)
- the dashboard, at the URL printed in the log (default `http://127.0.0.1:8787`)

The process stays in the foreground; stop it with `Ctrl+C` (or `SIGTERM`, which it handles
gracefully — see [Deploy as a service](#deploy-as-a-service-systemd)).

---

## Managing the agent

All scripts are one-shot CLI tools invoked with `npx tsx scripts/<name>.ts <args>`. Every one of
them opens the target wallet directly — **only one process may hold a given wallet at a time**
(see [Architecture & Safety](#architecture--safety)). **Stop the agent first** (`Ctrl+C`, or
`systemctl stop <service>`) before running any script that touches the `agent` wallet or writes
`store/rules.json` directly; the running agent's own in-memory copy of `rules.json` would silently
overwrite a second process's edit the next time any rule fires.

| Script | Usage | What it does |
|---|---|---|
| `mint.ts` | `mint.ts <role> <amount> [symbol=UCT]` | Mints test tokens into a wallet (creates the wallet if it doesn't exist). Supported symbols in the current testnet2 registry: `UCT`, `USDU`, `EURU`, `SOL`, `BTC`, `ETH`, `USDT`, `USDC`, `DDSC`, `ALPHT`. |
| `add-rule.ts` | `add-rule.ts <preset> [arg]` | Seeds a rule into `store/rules.json`. Presets shipped in the code today: `forward-normal`, `forward-oversized`, `split-with-invalid-leg`, `notify-on-incoming`, `balance-above <threshold>` (development/test presets using auto-created `partner`/`counterparty` wallets), and `notify-incoming`, `forward-fee`, `split-departments`, `conditional-forward`, `balance-watch [threshold]` (the `@ducky-*` branded demo rules — see [Demo rules](#demo-rules)). |
| `create-destination.ts` | `create-destination.ts <nametag>` | Creates a brand-new wallet under its own `data/<nametag>/` + `tokens/<nametag>/` directory and registers the **exact** nametag you request (refuses to run if that nametag is already taken by someone else, or already registered to a different wallet). Used to create branded destination wallets like `@ducky-fee`. |
| `set-rule-enabled.ts` | `set-rule-enabled.ts <ruleId> <true\|false>` | Enables or disables one rule by id. (The dashboard's toggle switch does the same thing safely while the agent is running — see below — because it goes through the agent's own in-memory rule store instead of writing the file from a second process.) |
| `check-balance.ts` | `check-balance.ts <role>` | Prints a wallet's current balance across all coins it holds. |
| `check-dms.ts` | `check-dms.ts <role>` | Prints a wallet's received DM history — the independent way to confirm a `notify` action actually reached its recipient. |

Everything above operates on a `<role>` — a short name that maps to `data/<role>/` and
`tokens/<role>/`. The main agent's role is always `agent`.

---

## Deploy as a service (systemd)

Example unit file (adjust `WorkingDirectory` and `User`):

```ini
# /etc/systemd/system/ducky-agent.service
[Unit]
Description=Ducky autonomous payment agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/conditional-payment-agent
ExecStart=/usr/bin/npm run agent
Restart=on-failure
RestartSec=5
User=ducky

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ducky-agent
sudo systemctl status ducky-agent
journalctl -u ducky-agent -f
```

`npm run agent` calls `tsx scripts/run-agent.ts` directly (see `package.json`) — no build step is
required. The process handles `SIGTERM` (what `systemctl stop` sends) by stopping the Scheduler,
closing the dashboard's HTTP listener, and releasing the wallet lock before exiting, so a restart
starts cleanly. If Node was installed via `nvm`, systemd won't see your shell's `PATH` — replace
`/usr/bin/npm` with the absolute path from `which npm` under that user.

---

## Rule model

A rule (`src/rules/types.ts`) has a `trigger`, an `action`, `guards`, and persisted `state`:

**Triggers**

```ts
{ type: 'onIncoming', fromSender?: string, minIncoming?: string }   // base units, string
{ type: 'onBalanceAbove' | 'onBalanceBelow', threshold: string, coinId: string }
```

**Actions**

```ts
{ type: 'forward', to: string, percent?: number, fixedAmount?: string, coinId: string, memo?: string }
{ type: 'split', splits: Array<{ to: string, percent: number }>, coinId: string }
{ type: 'notify', to: string, message: string }
```

**Guards** (all optional): `minAmount`, `maxTriggersPerHour`, `cooldownSeconds`, `excludeSenders`.
Loop protection (never pay the agent's own destinations, or itself) always runs on top of these
and cannot be turned off.

Example — forward 10% of any incoming payment of at least 1 UCT to a fee wallet:

```json
{
  "enabled": true,
  "trigger": { "type": "onIncoming", "minIncoming": "1000000000000000000" },
  "action": { "type": "forward", "to": "@ducky-fee", "percent": 10, "coinId": "f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0" },
  "guards": { "minAmount": "1000000000000000000" }
}
```

(Amounts are base units — UCT has 18 decimals, so `1000000000000000000` = 1 UCT.)

---

## Demo rules

The live instance ships 5 rules, seeded via `add-rule.ts`'s `@ducky-*` presets, all disabled by
default — turn one on from the dashboard to see it react:

1. **Notify** — when someone sends ≥ 1 UCT, alerts `@ducky-alerts`.
2. **Auto-fee** — forwards 10% of any incoming payment ≥ 1 UCT to `@ducky-fee`.
3. **Split** — divides any incoming payment ≥ 1 UCT: 50% `@ducky-savings`, 30% `@ducky-ops`, 20% `@ducky-charity`.
4. **Conditional** — only payments of 5 UCT or more get forwarded (100%) to `@ducky-savings`.
5. **Balance watch** — when Ducky's own balance passes 15 UCT, alerts `@ducky-alerts`.

---

## How reviewers can test

**Option 1 — use the live instance:**

1. Open the dashboard: http://103.167.88.212:8787
2. Turn on one of the 5 demo rules (toggle switch in the rules table).
3. From your own Sphere wallet on testnet2, send UCT to **@ducky**.
4. Watch the "Live activity log" — Ducky reacts within seconds.
5. Independently verify: check the balance change on the destination wallet (`@ducky-fee`,
   `@ducky-savings`, etc.) and cross-reference the timestamps/amounts in the live log.

**Option 2 — self-host:** follow [Installation & Setup](#installation--setup), then
`create-destination.ts` a wallet or two, `add-rule.ts` a preset, and send it a test transfer with
your own Sphere wallet.

**A note on verification:** Unicity's own-custody tokens are bearer objects that move
peer-to-peer, off-chain — there is no public block explorer where you paste a transfer ID and see
it, the way you would on Ethereum. (The public Unicity block explorer indexes the consensus/PoW
layer only; own-custody transfers don't appear there — confirmed by inspecting both the explorer's
source and the testnet2 aggregator's own API directly.) The correct way to verify a transfer
happened is what this README describes above: balance change on the receiving wallet, plus the
agent's own real-time log.

---

## Roadmap

- **Multi-token exchange** — accept coin X, pay out coin Y. The `action` schema already carries an
  explicit `coinId`; this mainly needs the Rule Matcher to filter on the *received* coin (it
  currently assumes the action's coin is what to look for) and a rate lookup. Registry-verified
  `coinId`s (as used throughout this project) prevent a spoofed/unregistered coin from being
  accepted as "payment."
- **Escrow-arbiter agent** — hold funds until a verified external condition releases them. Reuses
  the entire safety layer described above (process-lock, idempotency, split checkpointing,
  outcome-based fail-safe) unchanged; only a new business-logic layer (a state machine for
  "held" → "released"/"refunded") needs to be added on top.

---

## Tech stack

Node.js, TypeScript (strict mode, ESM), [`@unicitylabs/sphere-sdk`](https://github.com/unicity-sphere/sphere-sdk).
No LLM anywhere in the money path — every decision is deterministic arithmetic and if/then logic.

## Project structure

```
scripts/          CLI entry points — run-agent.ts is the always-on process, the rest are one-shot tools
src/wallet/       wallet init, process-lock
src/rules/        rule types, store, matcher, guards, executor, scheduler, engine
src/server/       dashboard (HTTP server + page) — runs inside the agent process, never a separate one
src/payments/     incoming-transfer amount aggregation
test/             unit tests (node:test)
store/            agent-owned runtime state (rules, idempotency, split checkpoints) — gitignored
data/ / tokens/   SDK-owned wallet + token state — gitignored, contains real key material
```

## License

MIT (see `package.json`).

---

*This project was built in verified phases, each with a written report and real testnet2
transaction IDs before moving to the next — including one real incident and its fix. See
`PHASE0_VERIFIED_API.md` through `PHASE4_REPORT.md`, `SPLIT_REPORT.md`, and
`GITHUB_SUBMISSION_REPORT.md` for the full build history.*
