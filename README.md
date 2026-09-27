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
bun src/cli.ts review
bun run --cwd client build   # build the dashboard
bun src/cli.ts serve         # dashboard at http://localhost:3000
```

## How it works

- **Pots** are managed directly in this app.
  The agent creates, renames, and retires pots as the budget evolves.
  Each pot has a target type: `fixed` (bills copied from history), `average_3mo`
  (variables), or `savings` (sinks that get leftovers, never assignments).
- **Splits**: every transaction is split by owner (`user` / `partner`).
  The user's share counts in their views; the partner's share is recorded
  as what they owe and never counted as the user's spending. Settlements
  allocate the partner's lump sums oldest-first.
- **Transfers** (`is_transfer`) move between the user's own accounts: counted in
  reconciliation, never in spending.
- **Review queue**: only entries the agent wasn't sure about land here. One tap
  to confirm.
- **Month-end close**: Ready-to-Assign must end at exactly $0; the leftover
  moves to secondary savings and next month's pot targets are wireframed from
  history. The agent applies the close after the user's review
  (`bun src/cli.ts close --month YYYY-MM` to preview).

## Status

Working app with live data (Aug 27 – Sep 26 2026).
The agent manages the budget directly.
