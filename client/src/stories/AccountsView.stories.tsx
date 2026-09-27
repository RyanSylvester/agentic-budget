import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { AccountsView } from "../App";
import { fixtureAccounts } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof AccountsView> = {
  title: "Accounts/AccountsView",
  component: AccountsView,
};

export default meta;
type Story = StoryObj<typeof AccountsView>;

const accounts = { accounts: fixtureAccounts };
const chequingId = fixtureAccounts[0].id;
const reconcileUrl = `/api/accounts/${chequingId}/reconcile`;

export const Mixed: Story = {
  parameters: {
    mockApi: { get: { "/api/accounts": accounts } } satisfies MockApiConfig,
  },
};

export const Loading: Story = {
  parameters: {
    mockApi: { get: { "/api/accounts": () => new Promise(() => {}) } } satisfies MockApiConfig,
  },
};

export const Error: Story = {
  parameters: {
    mockApi: { failGet: ["/api/accounts"] } satisfies MockApiConfig,
  },
};

export const Empty: Story = {
  parameters: {
    mockApi: { get: { "/api/accounts": { accounts: [] } } } satisfies MockApiConfig,
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
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const inputs = await canvas.findAllByPlaceholderText("Actual balance");
    await userEvent.type(inputs[0], "4120.50");
    const buttons = canvas.getAllByRole("button", { name: "Reconcile" });
    await userEvent.click(buttons[0]);
    await canvas.findByText("Balanced. Nice.");
  },
};

export const ReconcileWithDifference: Story = {
  parameters: {
    mockApi: {
      get: { "/api/accounts": accounts },
      post: {
        [reconcileUrl]: {
          differenceCents: -4500,
          balanced: false,
          clearedBalanceCents: 412050,
          actualBalanceCents: 407550,
          uncleared: [
            { id: 201, date: "2026-09-26", description: "Mock coffee stop", amount_cents: -485 },
            { id: 202, date: "2026-09-25", description: "Mock grocery run", amount_cents: -4015 },
          ],
          suggestedClearId: 202,
        },
        "/api/transactions/202/clear": { ok: true },
      },
    } satisfies MockApiConfig,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const inputs = await canvas.findAllByPlaceholderText("Actual balance");
    await userEvent.type(inputs[0], "4075.50");
    const buttons = canvas.getAllByRole("button", { name: "Reconcile" });
    await userEvent.click(buttons[0]);
    // the suggested transaction gets the prominent action
    await canvas.findByText("This one posted");
    await userEvent.click(canvas.getByRole("button", { name: "This one posted" }));
  },
};
