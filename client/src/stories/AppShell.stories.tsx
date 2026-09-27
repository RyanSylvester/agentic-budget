import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import App from "../App";
import {
  fixtureAccounts,
  fixtureContacts,
  fixtureListedTxns,
  fixturePots,
  fixtureReviewTxns,
  fixtureTrend,
  makeAttention,
  makeClosePreview,
  makeOverview,
} from "./fixtures";
import type { MockApiConfig } from "./mockApi";

/* Full app shell: sidebar, content, and tab navigation, all API routes mocked. */

const CUR = new Date().toISOString().slice(0, 7);

const fullApi = {
  get: {
    "/api/attention": makeAttention({ unsettledSharedCents: 42180, sharedOwedBy: [{ contactId: 1, name: "Alex", cents: 42180 }] }),
    "/api/review": { transactions: fixtureReviewTxns },
    [`/api/overview?month=${CUR}`]: makeOverview({ month: CUR }),
    [`/api/pots?month=${CUR}`]: { pots: fixturePots, rtaCents: 8633 },
    "/api/trend": { trend: fixtureTrend },
    [`/api/close-preview?month=${CUR}`]: makeClosePreview({ sharedOwedCents: 42180, sharedOwedBy: [{ name: "Alex", cents: 42180 }], month: CUR }),
    "/api/contacts": { contacts: fixtureContacts },
    "/api/accounts": { accounts: fixtureAccounts },
    [`/api/transactions?month=${CUR}`]: { month: CUR, transactions: fixtureListedTxns },
  },
} satisfies MockApiConfig;

const meta: Meta<typeof App> = {
  title: "App/Shell",
  component: App,
  parameters: {
    mockApi: fullApi,
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The whole app: sidebar navigation, month context, and all seven tabs, with every API route mocked. Use these stories to click through the full experience and to capture screens.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof App>;

async function goToTab(canvasElement: HTMLElement, label: string) {
  const aside = within(canvasElement).getByRole("complementary");
  // the Review button carries a count badge, so match the label as a prefix
  await userEvent.click(within(aside).getByRole("button", { name: new RegExp(`^${label}`) }));
}

export const Overview: Story = {
  parameters: {
    docs: { description: { story: "The app opens on the Overview tab." } },
  },
};

export const Pots: Story = {
  parameters: {
    docs: { description: { story: "Navigating to the Pots tab. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    await goToTab(canvasElement, "Pots");
    await within(canvasElement).findByText("Rent share");
  },
};

export const Transactions: Story = {
  parameters: {
    docs: { description: { story: "Navigating to the Transactions tab. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    await goToTab(canvasElement, "Transactions");
    await within(canvasElement).findByText("Mock grocery run");
  },
};

export const Close: Story = {
  parameters: {
    docs: { description: { story: "Navigating to the Close tab. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    await goToTab(canvasElement, "Close");
    await within(canvasElement).findByText("How the month closes");
  },
};

export const Sharing: Story = {
  parameters: {
    docs: { description: { story: "Navigating to the Sharing tab. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    await goToTab(canvasElement, "Sharing");
    await within(canvasElement).findByText("Alex");
  },
};

export const Review: Story = {
  parameters: {
    docs: { description: { story: "Navigating to the Review tab. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    await goToTab(canvasElement, "Review");
    await within(canvasElement).findByText("Mock ambiguous charge");
  },
};

export const Accounts: Story = {
  parameters: {
    docs: { description: { story: "Navigating to the Accounts tab. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    await goToTab(canvasElement, "Accounts");
    await within(canvasElement).findByText("Mock Credit Card");
  },
};
