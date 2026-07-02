# Conditional Payment Agent

> "IFTTT for P2P Money" — an autonomous payment agent on Unicity Testnet v2

**Unicity Builder Program — Track 01: Autonomous Agents**

A background process that owns its own [Sphere](https://sphere.unicity.network) wallet on Unicity
Testnet v2, listens for incoming transfers and balance changes, and automatically executes
money-moving rules a human configured ahead of time — forward a percentage to a partner, split a
payment across multiple recipients, or send a notification. No human approval step in the loop for
any individual action.

## Is this agentic?

**Yes.** The agent observes its own state autonomously (`transfer:incoming` events plus periodic
balance polling), decides autonomously (a deterministic Rule Matcher → Guard Check pipeline — no
LLM anywhere in the money path), and acts autonomously (calls `sphere.payments.send()` directly —
no approval modal, no Connect protocol, no human in the loop per action). A human's only role is
defining rules and their limits ahead of time. See [`CLAUDE.md`](CLAUDE.md) §2 for the full
reasoning behind this design.

## AstridOS

**Not yet.** Currently runs as a plain Node.js process, intended to run under `systemd` on a Linux
VPS. AstridOS packaging (tamper-evident BLAKE3 audit chain over every agent action) is planned as a
follow-up — see [`CLAUDE.md`](CLAUDE.md) §7.

## Quickstart (Testnet v2)

Requires Node.js >= 22.

```bash
git clone https://github.com/<your-username>/conditional-payment-agent.git
cd conditional-payment-agent
npm install
cp .env.example .env
```

`.env.example` already ships with a real testnet2 gateway key and endpoint (`ORACLE_API_KEY`,
`WALLET_API_BASE_URL`, `NETWORK`) — that key is intentionally public (see `CLAUDE.md` §0/§6 for
why), so **no editing is required** to run on testnet2.

Seed two demo wallets and two demo rules **before** starting the agent (see the warning box below
for why the order matters):

```bash
npx tsx scripts/mint.ts counterparty 10          # a funded test wallet to send FROM
npx tsx scripts/add-rule.ts notify-on-incoming   # rule: DM a partner wallet on every incoming transfer
npx tsx scripts/add-rule.ts forward-normal       # rule: auto-forward 10% of incoming from that wallet
```

Start the agent:

```bash
npm run agent
```

The first run creates the agent's own wallet and registers its nametag, then starts the
Rule Matcher → Guard Check → Action Executor loop (event-driven, plus a balance-polling Scheduler)
and a read-only dashboard at the URL printed in the log (default `http://127.0.0.1:8787`).

Open the dashboard to see the agent's nametag/address and the rules you just seeded. From
**another** Sphere wallet on testnet2 — or the bundled test script below — send it money:

```bash
npx tsx scripts/counterparty-send.ts 1 "hello agent"
```

Within a couple of seconds the dashboard's live log shows the incoming transfer, the rule match,
and the resulting forward/notify — independently cross-checkable on the
[Unicity Network Explorer](https://unicity.network) (paste in the nametag, address, or transfer id
shown in the log; no specific deep-link URL format is asserted here).

> **Why seed rules before starting the agent, not after?**
> `scripts/add-rule.ts` writes `store/rules.json` directly. The running agent keeps its own
> in-memory copy of that file and periodically writes it back to disk (every time any rule fires) —
> doing so overwrites whatever a second process wrote to the file in the meantime. Configure rules
> with the agent stopped. The dashboard's enable/disable toggle is the one exception: it's safe to
> use while the agent is running, because it mutates the agent's own in-memory rule store instead of
> writing the file from a second process. Full incident writeup: `SPLIT_REPORT.md` §5.

## Live dashboard

`TODO — filled in after VPS deployment.`

## Rules supported

| Trigger | Fields |
|---|---|
| `onIncoming` | optional `fromSender` (nametag), optional `minIncoming` (base units) |
| `onBalanceAbove` / `onBalanceBelow` | `threshold` (base units), `coinId` — polled by a background Scheduler |

| Action | Fields |
|---|---|
| `forward` | `to`, `percent` **or** `fixedAmount`, `coinId`, optional `memo` |
| `split` | `splits: [{ to, percent }, ...]`, `coinId` — sequential sends, checkpointed per leg |
| `notify` | `to`, `message` — sends a DM, moves no funds |

Every rule also supports guards: `minAmount`, `maxTriggersPerHour`, `cooldownSeconds`,
`excludeSenders`. Loop protection (never pay the agent's own destinations or itself) always runs
and is not configurable off. Full schema: [`src/rules/types.ts`](src/rules/types.ts).

`scripts/add-rule.ts` ships 5 presets used throughout development/testing —
`forward-normal`, `forward-oversized`, `split-with-invalid-leg`, `notify-on-incoming`,
`balance-above <threshold>` — the fastest way to seed a working rule without hand-writing JSON.
`store/rules.json` itself is gitignored (not shipped with committed test/debug state) — the
commands above create it fresh on your machine.

## Architecture & Safety

Money-safety is layered independently of business logic. Every wallet is protected by an atomic,
OS-verified process-lock (a PID file, liveness-checked via `process.kill(pid, 0)`, no `--force`
escape hatch) — two processes touching one wallet is a real corruption mode, discovered during
development (`SPLIT_REPORT.md` §5) and fixed at the infrastructure layer rather than patched
around. Every incoming transfer is claimed exactly once via an atomic filesystem primitive
(`open(..., O_CREAT|O_EXCL)`), not a check-then-act pair, closing the race between two events —
across processes or within one — seeing the same unprocessed transfer simultaneously. All engine
work (incoming events and balance-poll ticks) is serialized through a single promise queue
(`runExclusive`) so two rule evaluations can never interleave. Multi-recipient `split` actions
checkpoint each leg in two phases (`sending` written before the send, `sent` after) so a crash
mid-split resumes without re-paying a landed leg or guessing at one that didn't land. Fail-safe
logic gates only on the outcome of the agent's own `send()` call — never on a same-named SDK event,
which can fire for an internal retry that later succeeds.

None of this is specific to forward/split/notify. Locking, idempotency, serialization,
checkpointing, and outcome-based fail-safe form a general substrate for any agent that must move
real money autonomously — an escrow-arbiter agent (release funds on a verified external condition)
or a treasury manager agent (rebalance across wallets by policy) could reuse this exact safety
layer and swap out only the rule/business-logic layer on top.

## Testing

```bash
npm test         # unit tests — rule matching, guards, split checkpointing, idempotency, process-lock
npm run typecheck
```

Every money-moving behavior claimed above has also been exercised for real on testnet2, not just
unit-tested — see the phase reports below for real transaction IDs and raw logs.

## Engineering history / verification reports

This project was built in verified phases, each with a written report before moving to the next —
real testnet2 transaction IDs, not just unit tests, and an honest record of what was *not*
verified. Included for anyone who wants to see the actual process behind the "agentic" and
"safety" claims above, including one real incident and its fix:

- [`PHASE0_VERIFIED_API.md`](PHASE0_VERIFIED_API.md) — SDK API surface, verified against the installed `.d.ts`, not docs or memory
- [`PHASE1_REPORT.md`](PHASE1_REPORT.md) — wallet init, mint, send, receive
- [`PHASE2_REPORT.md`](PHASE2_REPORT.md) — rule engine, idempotency, guards, a real fail-safe test
- [`SPLIT_DESIGN_V2.md`](SPLIT_DESIGN_V2.md) / [`SPLIT_REPORT.md`](SPLIT_REPORT.md) — split-payment double-pay fix, including a real process-leak incident and recovery
- [`PHASE3_PROCESS_DESIGN.md`](PHASE3_PROCESS_DESIGN.md) / [`PHASE3_REPORT.md`](PHASE3_REPORT.md) — process-lifecycle safety, always-on loop
- [`PHASE4_REPORT.md`](PHASE4_REPORT.md) — dashboard

## Project structure

```
scripts/          CLI entry points — run-agent.ts is the always-on process, the rest are one-shot setup/test tools
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
