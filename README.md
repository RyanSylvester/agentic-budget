# agentic-budget

Agentic-first personal budgeting. The agent is the write path; the human gets
the understanding. Built around one person's actual rules instead of fighting
them.

Uncertainty is never parked in the app: when the agent isn't sure about an
entry, it asks the human in conversation instead of recording a guess.

## The idea

No bank sync. Data enters because the agent puts it there: it reads statements,
takes spending mentions from chat, and records everything through the `budget`
CLI. The human gets a read-mostly dashboard: the month at a glance, pot
balances, and trends. Data entry is the agent's job.

## Stack

TypeScript, [Hono](https://hono.dev) API and a React dashboard (Vite,
Tailwind). In production Daybook runs on **Cloudflare Workers**: one Worker
(`src/worker.ts`) serves the JSON API and the built client as static assets,
data lives in **D1** (hosted SQLite) and sessions in **KV**. It is
multi-user: people sign up with an invite code, and the agent authenticates
with a per-user bearer token. See `wrangler.toml` for the bindings.

Locally the same Hono app runs on [Bun](https://bun.sh) against a
`bun:sqlite` file, which is also what the tests use. Both runtimes share one
async database interface (`src/db-interface.ts`).

See the [context graph](https://github.com/RyanSylvester/agentic-budget-context)
for architecture notes and ADRs.

## Quick start (local)

```sh
bun install && (cd client && bun install)
bun run typecheck   # server, tests and client
bun test            # close math, settlement allocation, reconcile logic
bun src/cli.ts user create <username>
bun src/cli.ts record --account 1 --amount -12.50 --description "Voila" --source mention
bun src/cli.ts assign --month 2026-09 --pot "Eating Out" --cents 60000
bun run --cwd client build   # build the dashboard
bun src/cli.ts serve         # dashboard at http://localhost:3111
```

## Using the hosted Worker

The `budget` CLI talks to the Worker instead of a local database once it has
remote config:

```sh
bun src/cli.ts login --api-url https://<your-worker>   # prompts for an agent token
```

`BUDGET_API_URL` and `BUDGET_API_TOKEN` override the saved config. In remote
mode `serve`, `user` and `migration` are local-only and refuse to run.
Database migrations live in `src/migrations` and are applied to D1 with
`budget migrate-remote` (or `wrangler d1 migrations apply daybook --local`
for `wrangler dev`). Deploying is `bun run --cwd client build` followed by
`wrangler deploy`.

## How it works

- **Pots** are managed directly in this app (`budget pot create|rename|retire|unhide`).
  The agent creates, renames, and retires pots as the budget evolves.
  Each pot has a target type: `fixed` (bills copied from history), `average_3mo`
  (variables), or `savings` (sinks that get leftovers, never assignments).
  Income-group pots (paychecks, interest, windfalls) receive money and are
  never assigned to.
- **Assignments**: income arrives, then every dollar is assigned to a pot
  (`budget assign --month YYYY-MM --pot <id|name> --cents N`, idempotent).
  Ready-to-Assign = inflows − assignments; the month ends with RTA at exactly
  $0, and the close refuses to apply otherwise.
  Spending pots also take negative assignments for offsets a mirrored budget
  balances with, such as a pay-yourself bridge or a contact's reimbursed half
  of a bill (`--cents -514946`); they hand dollars back to RTA. Income pots
  never take negatives, since their assignment means planned income.
- **Splits**: every transaction is split by owner (`user` / `contact`).
  The user's share counts in their views; a contact's share is recorded
  as what they owe and never counted as the user's spending. Settlements
  allocate a contact's lump sums oldest-first, consuming prior credit first.
  Each contact is managed in the Sharing tab; each pot can carry a default
  share config (contact + percent) for new splits.
- **Transfers** (`is_transfer`) move between the user's own accounts: counted in
  reconciliation, never in spending.
- **Idempotency**: `budget record --external-id KEY` never records the same
  statement twice; `budget void --id N` soft-voids a transaction (excluded
  from spend and RTA, kept for audit).
- **Month-end close**: Ready-to-Assign must end at exactly $0; the leftover
  moves to secondary savings and next month's pot targets are wireframed from
  history. The agent applies the close once the numbers balance
  (`bun src/cli.ts close --month YYYY-MM` to preview).
- **Sinking schedules** spread annual bills to a monthly contribution
  (`budget sinking add --pot <id|name> --expected 3483.59 --due 2027-07`,
  `list`, `paid`, `remove`). One row per pot: the monthly number is derived
  as ceil((expected − saved so far) / months left), so missed months and
  amount changes rescale automatically. Marking a bill paid rolls the due
  date forward a year. Scheduled pots use the schedule instead of the
  history strategies when scaffolding a month, and the close wireframe
  leaves their targets alone.
- **Agent surface**: `GET /api/attention` returns the machine-readable ritual
  summary (unreconciled accounts, RTA, unsettled contact
  balances) for the agent's weekly run.

## Status

Live on Cloudflare Workers + D1 with real data since August 2026. The agent
manages the budget directly through the CLI in remote mode. CI runs the
typecheck, tests and client build on every pull request.
