import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { OverviewTab } from "../OverviewTab";
import { fixtureAccounts, makeAttention, makeOverview, MONTH } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof OverviewTab> = {
  title: "Tabs/OverviewTab",
  component: OverviewTab,
  args: { month: MONTH, onGo: fn() },
  parameters: {
    docs: {
      description: {
        component: "The full Overview tab: hero totals, the attention card, and recent activity, with loading and error states.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof OverviewTab>;

const overviewUrl = `/api/overview?month=${MONTH}`;

const fullApi = {
  get: {
    [overviewUrl]: makeOverview(),
    "/api/attention": makeAttention({ unsettledSharedCents: 42180, sharedOwedBy: [{ contactId: 1, name: "Alex", cents: 42180 }] }),
    "/api/accounts": { accounts: fixtureAccounts },
  },
} satisfies MockApiConfig;

export const Loaded: Story = {
  parameters: {
    mockApi: fullApi,
    docs: { description: { story: "Everything loaded with items needing attention." } },
  },
};

export const Quiet: Story = {
  parameters: {
    mockApi: {
      get: {
        [overviewUrl]: makeOverview(),
        "/api/attention": makeAttention({
          unreconciledAccounts: [],
          rtaCents: 0,
          unsettledSharedCents: 0,
        }),
        "/api/accounts": { accounts: fixtureAccounts },
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "A calm month: nothing needs attention, so the card stays hidden." } },
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
    docs: { description: { story: "Skeletons while the overview loads." } },
  },
};

export const Error: Story = {
  parameters: {
    mockApi: {
      failGet: [overviewUrl],
      get: { "/api/attention": makeAttention() },
    } satisfies MockApiConfig,
    docs: { description: { story: "The shared error card with retry when the overview fails." } },
  },
};
