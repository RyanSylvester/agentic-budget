# agentic-budget

Agentic-first personal budgeting. The agent is the write path; the human gets
the understanding. Built around one person's actual rules instead of fighting
them.

## The idea

No bank sync. Data enters because the agent puts it there: it reads statements,
takes spending mentions from chat, and records everything through the `budget`
CLI. The human gets a read-mostly dashboard: the month at a glance, pot
balances, trends, and a review screen. The weekly review is the product
surface; data entry is the agent's job.

## Stack

TypeScript on [Bun](https://bun.sh), SQLite (`bun:sqlite`), [Hono](https://hono.dev)
API + React dashboard (Vite, Tailwind). See the
[context graph](https://github.com/RyanSylvester/agentic-budget-context) for
architecture notes and ADRs.

## Quick start

```sh
bun install
bun test            # close math, settlement allocation, reconcile logic
bun src/cli.ts record --account 1 --amount -12.50 --description "Voila" --source mention
bun src/cli.ts assign --month 2026-09 --pot "Eating Out" --cents 60000
bun src/cli.ts review
bun run --cwd client build   # build the dashboard
bun src/cli.ts serve         # dashboard at http://localhost:3111
```

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
- **Splits**: every transaction is split by owner (`user` / `contact`).
  The user's share counts in their views; a contact's share is recorded
  as what they owe and never counted as the user's spending. Settlements
  allocate a contact's lump sums oldest-first, consuming prior credit first.
  Each contact is managed in the Sharing tab; each pot can carry a default
  share config (contact + percent) for new splits.
- **Transfers** (`is_transfer`) move between the user's own accounts: counted in
  reconciliation, never in spending.
- **Review queue**: only entries the agent wasn't sure about land here. One tap
  to confirm, optionally recategorizing at the same time.
- **Idempotency**: `budget record --external-id KEY` never records the same
  statement twice; `budget void --id N` soft-voids a transaction (excluded
  from spend and RTA, kept for audit).
- **Month-end close**: Ready-to-Assign must end at exactly $0; the leftover
  moves to secondary savings and next month's pot targets are wireframed from
  history. The agent applies the close after the user's review
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
  summary (pending reviews, unreconciled accounts, RTA, unsettled contact
  balances) for the agent's weekly run.

## Status

Working app with live data (Aug 27 – Sep 26 2026).
The agent manages the budget directly.
