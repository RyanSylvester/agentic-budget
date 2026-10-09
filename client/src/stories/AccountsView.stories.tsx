import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { AccountsView } from "../AccountsTab";
import { fixtureAccounts } from "./fixtures";
import type { ReconcileResponse } from "../types";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof AccountsView> = {
  title: "Accounts/AccountsView",
  component: AccountsView,
  parameters: {
    docs: {
      description: {
        component:
          "Bank and credit accounts with balances. Each account can be reconciled against its real-world balance; credit cards show what is owed.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof AccountsView>;

const accounts = { accounts: fixtureAccounts };
const chequingId = fixtureAccounts[0].id;
const reconcileUrl = `/api/accounts/${chequingId}/reconcile`;
const card = fixtureAccounts[1];
const cardReconcileUrl = `/api/accounts/${card.id}/reconcile`;

export const Mixed: Story = {
  parameters: {
    mockApi: { get: { "/api/accounts": accounts } } satisfies MockApiConfig,
    docs: { description: { story: "Chequing, savings, and a credit card showing its owed balance." } },
  },
};

export const Loading: Story = {
  parameters: {
    mockApi: { get: { "/api/accounts": () => new Promise(() => {}) } } satisfies MockApiConfig,
    docs: { description: { story: "Skeleton rows while accounts load." } },
  },
};

export const Error: Story = {
  parameters: {
    mockApi: { failGet: ["/api/accounts"] } satisfies MockApiConfig,
    docs: { description: { story: "The shared error card with retry." } },
  },
};

export const Empty: Story = {
  parameters: {
    mockApi: { get: { "/api/accounts": { accounts: [] } } } satisfies MockApiConfig,
    docs: { description: { story: "No accounts yet: the empty state." } },
  },
};

export const ReconcileBalanced: Story = {
  parameters: {
    mockApi: {
      get: { "/api/accounts": accounts },
      post: {
        [reconcileUrl]: {
          differenceCents: 0,
          balanced: true,
          clearedBalanceCents: 412050,
          actualBalanceCents: 412050,
        },
      },
    } satisfies MockApiConfig,
    docs: {
      description: { story: "Entering the true balance matches: the account is marked balanced. (Interaction test.)" },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const inputs = await canvas.findAllByPlaceholderText("Actual balance");
    await userEvent.type(inputs[0], "4120.50");
    const buttons = canvas.getAllByRole("button", { name: "Reconcile" });
    await userEvent.click(buttons[0]);
    await canvas.findByText("Balanced");
  },
};

/* A tiny stateful server for the one-pass flow: clearing a transaction moves
   it into the cleared balance, so the next reconcile reports what remains. */
const posted = { cleared: 412050, uncleared: [] as { id: number; date: string; description: string; amount_cents: number }[] };
const resetPosted = () => {
  posted.cleared = 412050;
  posted.uncleared = [
    { id: 201, date: "2026-09-26", description: "Mock coffee stop", amount_cents: -485 },
    { id: 202, date: "2026-09-25", description: "Mock grocery run at the big supermarket", amount_cents: -4015 },
  ];
};
resetPosted();
const reconcileAgainst = (body: unknown): ReconcileResponse => {
  const actual = (body as { actualBalanceCents: number }).actualBalanceCents;
  const differenceCents = actual - posted.cleared;
  if (differenceCents === 0) return { differenceCents, balanced: true, clearedBalanceCents: posted.cleared, actualBalanceCents: actual };
  return {
    differenceCents,
    balanced: false,
    clearedBalanceCents: posted.cleared,
    actualBalanceCents: actual,
    uncleared: posted.uncleared,
    suggestedClearId: posted.uncleared.find((t) => t.amount_cents === differenceCents)?.id ?? null,
  };
};
const clearPosted = (id: number) => () => {
  const t = posted.uncleared.find((x) => x.id === id);
  if (t) {
    posted.cleared += t.amount_cents;
    posted.uncleared = posted.uncleared.filter((x) => x.id !== id);
  }
  return { ok: true };
};

export const ReconcileWithDifference: Story = {
  parameters: {
    mockApi: {
      get: { "/api/accounts": accounts },
      post: {
        [reconcileUrl]: reconcileAgainst,
        "/api/transactions/201/clear": clearPosted(201),
        "/api/transactions/202/clear": clearPosted(202),
      },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story:
          "A mismatch says which way it is off and lists uncleared transactions. Clearing one keeps the typed balance and re-checks automatically, showing what remains. (Interaction test: stops with $4.85 left.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    resetPosted();
    const canvas = within(canvasElement);
    const inputs = await canvas.findAllByPlaceholderText("Actual balance");
    await userEvent.type(inputs[0], "4075.50{Enter}");
    await canvas.findByText(/Your bank shows \$45\.00 less than Daybook/);
    // the grocery run posted (second row)
    await userEvent.click(canvas.getAllByRole("button", { name: "Clear" })[1]);
    // the remaining difference updates in place; the typed balance stays
    await canvas.findByText(/Your bank shows \$4\.85 less than Daybook/);
    await expect(inputs[0]).toHaveValue("4075.50");
    await canvas.findByRole("button", { name: "This one posted" });
  },
};

export const ReconcileOnePass: Story = {
  parameters: {
    ...ReconcileWithDifference.parameters,
    docs: { description: { story: "Clearing both posted transactions in a row ends in the Balanced state without retyping. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    resetPosted();
    const canvas = within(canvasElement);
    const inputs = await canvas.findAllByPlaceholderText("Actual balance");
    await userEvent.type(inputs[0], "4075.50{Enter}");
    await userEvent.click((await canvas.findAllByRole("button", { name: "Clear" }))[1]);
    await userEvent.click(await canvas.findByRole("button", { name: "This one posted" }));
    await canvas.findByText("Balanced");
  },
};

export const CreditCardStatement: Story = {
  parameters: {
    mockApi: {
      get: { "/api/accounts": accounts },
      post: {
        [cardReconcileUrl]: (body: unknown) => {
          const actual = (body as { actualBalanceCents: number }).actualBalanceCents;
          const differenceCents = actual - card.clearedBalanceCents;
          return { differenceCents, balanced: differenceCents === 0, clearedBalanceCents: card.clearedBalanceCents, actualBalanceCents: actual, uncleared: [], suggestedClearId: null };
        },
      },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story: "Credit cards ask for the positive amount owed on the statement; the sign is flipped before posting, so 653.65 balances. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByPlaceholderText("Amount owed");
    await userEvent.type(input, "653.65{Enter}");
    await canvas.findByText("Balanced");
  },
};

export const ReconcileErrors: Story = {
  parameters: {
    mockApi: { get: { "/api/accounts": accounts }, failPost: [reconcileUrl] } satisfies MockApiConfig,
    docs: { description: { story: "Invalid input and a failed request both explain themselves inline. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const inputs = await canvas.findAllByPlaceholderText("Actual balance");
    await userEvent.type(inputs[0], "abc{Enter}");
    await canvas.findByText(/doesn't look like an amount/);
    await userEvent.clear(inputs[0]);
    await userEvent.type(inputs[0], "4075.50{Enter}");
    await canvas.findByText(/Couldn't reconcile right now/);
  },
};

export const StaleReconciliation: Story = {
  parameters: {
    mockApi: {
      get: { "/api/accounts": { accounts: [{ ...fixtureAccounts[0], lastReconciledAt: "2026-07-02T10:00:00" }, fixtureAccounts[1]] } },
    } satisfies MockApiConfig,
    docs: { description: { story: "A reconciliation more than 30 days old is flagged in the warning colour." } },
  },
};
