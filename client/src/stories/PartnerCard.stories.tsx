import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { PartnerCard } from "../App";
import { fixtureAccounts, makePartnerInfo } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof PartnerCard> = {
  title: "Partner/PartnerCard",
  component: PartnerCard,
  parameters: {
    docs: {
      description: {
        component:
          "The partner settlement card. It totals what the partner owes across shared pots, applies any credit first, and records payments received.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PartnerCard>;

const accounts = { accounts: fixtureAccounts };

export const Owes: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/partner": makePartnerInfo(),
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "A balance owed across shared pots." } },
  },
};

export const OwesWithCredit: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/partner": makePartnerInfo({ creditCents: 15000 }),
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Existing credit reduces what is owed before anything new is counted." } },
  },
};

export const Settled: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/partner": makePartnerInfo({ totalOwedCents: 0, creditCents: 0, byPot: [], oldest: null }),
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Nothing owed: the settled state." } },
  },
};

export const Loading: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/partner": () => new Promise(() => {}),
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Skeleton while the partner balance loads." } },
  },
};

export const Error: Story = {
  parameters: {
    mockApi: {
      failGet: ["/api/partner"],
      get: { "/api/accounts": accounts },
    } satisfies MockApiConfig,
    docs: { description: { story: "The shared error card with retry." } },
  },
};

export const SettleFlow: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/partner": makePartnerInfo(),
        "/api/accounts": accounts,
      },
      post: {
        "/api/settle": {
          allocations: [
            { potName: "Rent share", amountCents: 35210 },
            { potName: "Groceries", amountCents: 6970 },
          ],
          leftoverCents: 0,
        },
      },
    } satisfies MockApiConfig,
    docs: {
      description: { story: "Recording a payment fills the shared pots and confirms. (Interaction test.)" },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByLabelText("Payment amount received");
    await userEvent.type(input, "421.80");
    await userEvent.click(canvas.getByRole("button", { name: "Settle up" }));
    await canvas.findByText("Buckets filled");
  },
};

export const SettleFails: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/partner": makePartnerInfo(),
        "/api/accounts": accounts,
      },
      failPost: ["/api/settle"],
    } satisfies MockApiConfig,
    docs: { description: { story: "A failed payment shows an inline error; nothing is recorded." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByLabelText("Payment amount received");
    await userEvent.type(input, "100");
    await userEvent.click(canvas.getByRole("button", { name: "Settle up" }));
    await canvas.findByText("Couldn't record that. Try again.");
  },
};

export const NoChequingAccount: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/partner": makePartnerInfo(),
        "/api/accounts": { accounts: [] },
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Settling is disabled until at least one chequing account exists." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Loading accounts…");
    const btn = canvas.getByRole("button", { name: "Settle up" });
    await expect(btn).toBeDisabled();
  },
};
