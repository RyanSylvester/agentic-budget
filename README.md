# agentic-budget

Agentic-first personal budgeting. The agent is the write path; the human gets
the understanding. A replacement for YNAB, built around one person's actual
rules instead of fighting them.

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

- **Pots** mirror budget categories 1:1 (seeded from YNAB: 51 pots in 10 groups).
  Each pot has a target type: `fixed` (bills copied from history), `average_3mo`
  (variables), or `savings` (sinks that get leftovers, never assignments).
- **Splits**: every transaction is split by owner. Ryan's share counts in his
  views; Lilly's share is recorded as what she owes and never counted as his
  spending. Settlements allocate her lump sums oldest-first.
- **Transfers** (`is_transfer`) move between his own accounts: counted in
  reconciliation, never in spending.
- **Review queue**: only entries the agent wasn't sure about land here. One tap
  to confirm.
- **Month-end close**: Ready-to-Assign must end at exactly $0; the leftover
  moves to secondary savings and next month's pot targets are wireframed from
  history. The agent applies the close after Ryan's review
  (`bun src/cli.ts close --month YYYY-MM` to preview).

## Status

Working app with live data (imported from YNAB Aug 27 – Sep 26 2026).
Blocked on Ryan: YNAB API token (full history import), Turso signup (shared DB).
