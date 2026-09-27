import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import App from "../App";
import {
  fixtureAccounts,
  fixtureHistory,
  fixturePots,
  fixtureReviewTxns,
  makeAttention,
  makeClosePreview,
  makeOverview,
  makePartnerInfo,
} from "./fixtures";
import type { MockApiConfig } from "./mockApi";

/* Full app shell: sidebar, content, and tab navigation, all API routes mocked. */

const CUR = new Date().toISOString().slice(0, 7);
const topPot = [...fixturePots].sort((a, b) => b.spentCents - a.spentCents)[0];

const fullApi = {
  get: {
    "/api/attention": makeAttention({ unsettledPartnerCents: 42180 }),
    "/api/review": { transactions: fixtureReviewTxns },
    [`/api/overview?month=${CUR}`]: makeOverview({ month: CUR }),
    [`/api/pots?month=${CUR}`]: { pots: fixturePots },
    [`/api/close-preview?month=${CUR}`]: makeClosePreview({ partnerOwedCents: 42180, month: CUR }),
    "/api/partner": makePartnerInfo(),
    "/api/accounts": { accounts: fixtureAccounts },
    [`/api/pot-history?potId=${topPot.id}&months=6`]: { history: fixtureHistory },
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

export const Insights: Story = {
  parameters: {
    docs: { description: { story: "Navigating to the Insights tab. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    await goToTab(canvasElement, "Insights");
    await within(canvasElement).findByText("Where the money went");
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

export const Partner: Story = {
  parameters: {
    docs: { description: { story: "Navigating to the Partner tab. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    await goToTab(canvasElement, "Partner");
    await within(canvasElement).findByText("Partner owes you");
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
