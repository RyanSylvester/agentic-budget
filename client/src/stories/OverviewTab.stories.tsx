import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { OverviewTab } from "../App";
import { fixtureAccounts, makeAttention, makeOverview, MONTH } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof OverviewTab> = {
  title: "Tabs/OverviewTab",
  component: OverviewTab,
  args: { month: MONTH, onGo: fn() },
};

export default meta;
type Story = StoryObj<typeof OverviewTab>;

const overviewUrl = `/api/overview?month=${MONTH}`;

const fullApi = {
  get: {
    [overviewUrl]: makeOverview(),
    "/api/attention": makeAttention({ unsettledPartnerCents: 42180 }),
    "/api/accounts": { accounts: fixtureAccounts },
  },
} satisfies MockApiConfig;

export const Loaded: Story = {
  parameters: { mockApi: fullApi },
};

export const Quiet: Story = {
  parameters: {
    mockApi: {
      get: {
        [overviewUrl]: makeOverview(),
        "/api/attention": makeAttention({
          pendingReviewCount: 0,
          unreconciledAccounts: [],
          rtaCents: 0,
          unsettledPartnerCents: 0,
        }),
        "/api/accounts": { accounts: fixtureAccounts },
      },
    } satisfies MockApiConfig,
  },
};

export const Loading: Story = {
  parameters: {
    mockApi: {
      get: {
        [overviewUrl]: () => new Promise(() => {}),
        "/api/attention": () => new Promise(() => {}),
      },
    } satisfies MockApiConfig,
  },
};

export const Error: Story = {
  parameters: {
    mockApi: {
      failGet: [overviewUrl],
      get: { "/api/attention": makeAttention() },
    } satisfies MockApiConfig,
  },
};
