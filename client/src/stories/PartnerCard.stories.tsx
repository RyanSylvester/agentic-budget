import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { PartnerCard } from "../App";
import { fixtureAccounts, makePartnerInfo } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof PartnerCard> = {
  title: "Partner/PartnerCard",
  component: PartnerCard,
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
  },
};

export const Error: Story = {
  parameters: {
    mockApi: {
      failGet: ["/api/partner"],
      get: { "/api/accounts": accounts },
    } satisfies MockApiConfig,
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
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Loading accounts…");
    const btn = canvas.getByRole("button", { name: "Settle up" });
    await expect(btn).toBeDisabled();
  },
};
