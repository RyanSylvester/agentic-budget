/** YNAB is the source of truth for the category taxonomy — like YNAB's own
 *  architecture, categories are data synced by stable id, never hardcoded.
 *
 *  Each pot carries `ynab_id` (the YNAB category UUID) and `ynab_group_id`
 *  (the YNAB category-group UUID). Names and groups are labels: renames in
 *  YNAB flow through on the next sync; the ids never change. Transactions
 *  imported from YNAB later resolve their pot via `potIdForYnabId`.
 *
 *  Token: `YNAB_TOKEN` env (personal access token). Budget: `YNAB_BUDGET_ID`
 *  env, otherwise the budget flagged last-used, otherwise a name match on
 *  "Ryan's Personal Budget".
 */
import type { Database } from "bun:sqlite";

const YNAB_BASE = "https://api.ynab.com/v1";

export interface YnabCategory {
  id: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
}

export interface YnabCategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
  categories: YnabCategory[];
}

async function ynabFetch(token: string, path: string): Promise<any> {
  const res = await fetch(`${YNAB_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`YNAB ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()).data;
}

export async function listBudgets(token: string): Promise<{ id: string; name: string; last_used: boolean }[]> {
  const data = await ynabFetch(token, "/budgets?include_accounts=false");
  return data.budgets;
}

export async function resolveBudgetId(token: string): Promise<{ id: string; name: string }> {
  const env = process.env.YNAB_BUDGET_ID;
  const budgets = await listBudgets(token);
  if (env) {
    const b = budgets.find((x) => x.id === env);
    if (!b) throw new Error(`YNAB_BUDGET_ID ${env} not found`);
    return { id: b.id, name: b.name };
  }
  const lastUsed = budgets.find((x) => x.last_used);
  if (lastUsed) return { id: lastUsed.id, name: lastUsed.name };
  const named = budgets.find((x) => /ryan/i.test(x.name));
  if (named) return { id: named.id, name: named.name };
  throw new Error("no YNAB budget found (set YNAB_BUDGET_ID)");
}

export async function fetchCategoryGroups(token: string, budgetId: string): Promise<YnabCategoryGroup[]> {
  const data = await ynabFetch(token, `/budgets/${budgetId}/categories`);
  return data.category_groups;
}

export interface SyncReport {
  budgetName: string;
  created: string[];
  linked: string[];   // existing pots matched by name, now carrying ynab_id
  renamed: string[];  // "old -> new"
  hidden: string[];
  unhidden: string[];
  skippedGroups: string[];
}

/** Sync the pot taxonomy from YNAB. Idempotent: safe to run weekly. */
export async function syncCategories(db: Database, token: string, budgetId: string, budgetName: string): Promise<SyncReport> {
  const report: SyncReport = { budgetName, created: [], linked: [], renamed: [], hidden: [], unhidden: [], skippedGroups: [] };
  const groups = await fetchCategoryGroups(token, budgetId);

  const byYnabId = db.query("SELECT id, name, pot_group, hidden FROM pots WHERE ynab_id = ?");
  const byName = db.query("SELECT id, name, pot_group, hidden, ynab_id FROM pots WHERE name = ?");
  const setYnab = db.query("UPDATE pots SET ynab_id = ?, ynab_group_id = ?, name = ?, pot_group = ?, hidden = ? WHERE id = ?");
  const insertPot = db.query(
    "INSERT INTO pots (name, pot_group, target_type, target_cents, ynab_id, ynab_group_id, hidden) VALUES (?, ?, 'average_3mo', 0, ?, ?, ?)"
  );

  for (const g of groups) {
    if (g.deleted) continue;
    // YNAB's internal mechanics group (Ready to Assign / Uncategorized) is
    // not a spending taxonomy — same as our standing rule for the Income and
    // Credit Card Payments groups.
    if (g.name === "Internal Master Category") {
      report.skippedGroups.push(g.name);
      continue;
    }
    // Keep group labels fresh if YNAB renamed the group.
    db.query("UPDATE pots SET pot_group = ? WHERE ynab_group_id = ? AND pot_group != ?").run(g.name, g.id, g.name);

    for (const c of g.categories) {
      const hidden = c.hidden || c.deleted ? 1 : 0;
      const existing = byYnabId.get(c.id) as { id: number; name: string; pot_group: string; hidden: number } | null;
      if (existing) {
        const changes: string[] = [];
        if (existing.name !== c.name) {
          report.renamed.push(`${existing.name} -> ${c.name}`);
          changes.push("name");
        }
        if (existing.hidden !== hidden) {
          (hidden ? report.hidden : report.unhidden).push(c.name);
          changes.push("hidden");
        }
        if (changes.length > 0 || existing.pot_group !== g.name) {
          setYnab.run(c.id, g.id, c.name, g.name, hidden, existing.id);
        }
        continue;
      }
      // First run: link the pots seeded from YNAB names by exact name match.
      const named = byName.get(c.name) as { id: number; ynab_id: string | null } | null;
      if (named && !named.ynab_id) {
        setYnab.run(c.id, g.id, c.name, g.name, hidden, named.id);
        report.linked.push(c.name);
        continue;
      }
      // Genuinely new category in YNAB — adopt it. Target type defaults to
      // average_3mo (variable); the agent or Ryan assigns the real target.
      insertPot.run(c.name, g.name, c.id, g.id, hidden);
      report.created.push(`${g.name} / ${c.name}`);
    }
  }
  return report;
}

/** Resolve a YNAB category id to a pot id (for transaction imports). */
export function potIdForYnabId(db: Database, ynabId: string): number | null {
  const row = db.query("SELECT id FROM pots WHERE ynab_id = ?").get(ynabId) as { id: number } | null;
  return row?.id ?? null;
}
