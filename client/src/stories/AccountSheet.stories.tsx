import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AccountSheet } from "../AccountSheet";
import { AccountsView } from "../AccountsTab";
import { makeAccount } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof AccountSheet> = {
  title: "Accounts/AccountSheet",
  component: AccountSheet,
  args: { onClose: fn(), onSaved: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "Add a bank or card account: name, type (chequing, savings or credit card) and optional last four digits. Accounts start at zero; reconciling brings them in line with the bank.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof AccountSheet>;

/** A stateful mock: POST adds to the list, so the Accounts tab refreshes with it. */
const created: ReturnType<typeof makeAccount>[] = [];
const accountsApi = {
  get: { "/api/accounts": () => ({ accounts: created }) },
  post: {
    "/api/accounts": (body: unknown) => {
      const b = body as { name: string; type: "chequing" | "savings" | "credit_card"; last4: string | null };
      const account = makeAccount({ name: b.name, type: b.type, last4: b.last4, workingBalanceCents: 0, clearedBalanceCents: 0, lastReconciledAt: null });
      created.push(account);
      return { ok: true, id: account.id, account };
    },
  },
} satisfies MockApiConfig;

export const Empty: Story = {
  parameters: {
    mockApi: accountsApi,
    docs: { description: { story: "A fresh sheet: chequing is preselected and the add button waits for a name." } },
  },
};

export const CreditCard: Story = {
  parameters: {
    mockApi: accountsApi,
    docs: { description: { story: "Filled in for a credit card with its last four digits. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.type(canvas.getByLabelText("Name"), "Travel card");
    await userEvent.click(canvas.getByRole("button", { name: "Credit card" }));
    await userEvent.type(canvas.getByLabelText(/Last four digits/), "9012");
    await expect(canvas.getByText(/Card balances show what you owe/)).toBeInTheDocument();
  },
};

export const BadLast4: Story = {
  parameters: {
    mockApi: accountsApi,
    docs: { description: { story: "Last four digits that aren't four numbers explain themselves inline. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.type(canvas.getByLabelText("Name"), "Everyday");
    await userEvent.type(canvas.getByLabelText(/Last four digits/), "12{Enter}");
    await canvas.findByText(/exactly 4 numbers/);
  },
};

/** The flow from an empty Accounts tab: open the sheet, add, see the list. */
export const FromEmptyAccounts: StoryObj<typeof AccountsView> = {
  render: () => <AccountsView />,
  parameters: {
    mockApi: accountsApi,
    docs: { description: { story: "Empty Accounts tab → Add your first account → the new account appears in the list. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    created.length = 0;
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole("button", { name: "Add your first account" }));
    await userEvent.type(body.getByLabelText("Name"), "Everyday chequing{Enter}");
    await body.findByText("Everyday chequing");
    await expect(body.queryByText("No accounts yet")).not.toBeInTheDocument();
  },
};
