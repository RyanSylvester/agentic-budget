# agentic-budget

Agentic-first personal budgeting. The agent is the write path; the human gets
the understanding. A replacement for YNAB, built around one person's actual
rules instead of fighting them.

## The idea

No bank sync. Data enters because the agent puts it there: it reads Gmail
statements, takes spending mentions from chat, and records everything through
the `budget` CLI. The human gets a read-mostly dashboard: the month at a
glance, pot balances, trends, and a review screen. The weekly review is the
product surface; data entry is the agent's job.

## Stack

TypeScript on [Bun](https://bun.sh), SQLite (`bun:sqlite`), [Hono](https://hono.dev)
server-rendered dashboard. See the
[context graph](https://github.com/RyanSylvester/agentic-budget-context) for
architecture notes and ADRs.

## Quick start

```sh
bun install
bun test            # close math and pot logic
bun src/cli.ts record --account 1 --amount -12.50 --description "Voila" --source mention
bun src/cli.ts review
bun src/cli.ts serve   # dashboard at http://localhost:3000
```

## Status

Early scaffold. The data model is still draft pending a scoping session; see
`src/schema.sql` and the context graph.
