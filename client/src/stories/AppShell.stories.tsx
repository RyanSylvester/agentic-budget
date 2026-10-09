import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { AppShell } from "../AppShell";
import { currentMonthLocal } from "../format";
import {
  fixtureAccounts,
  fixtureContacts,
  fixtureListedTxns,
  fixturePots,
  fixtureTrend,
  makeAttention,
  makeClosePreview,
  makeOverview,
} from "./fixtures";
import type { MockApiConfig } from "./mockApi";

/* Full app shell: sidebar, content, and tab navigation, all API routes mocked. */

const CUR = currentMonthLocal();

const fullApi = {
  get: {
    "/api/attention": makeAttention({ unsettledSharedCents: 42180, sharedOwedBy: [{ contactId: 1, name: "Alex", cents: 42180, netCents: 42180 }] }),
    [`/api/overview?month=${CUR}`]: makeOverview({ month: CUR }),
    [`/api/pots?month=${CUR}`]: { pots: fixturePots, rtaCents: 8633 },
    "/api/trend": { trend: fixtureTrend },
    [`/api/close-preview?month=${CUR}`]: makeClosePreview({ sharedOwedCents: 42180, sharedOwedBy: [{ name: "Alex", cents: 42180 }], month: CUR }),
    "/api/contacts": { contacts: fixtureContacts },
    "/api/contacts?archived=1": { contacts: fixtureContacts },
    "/api/accounts": { accounts: fixtureAccounts },
    [`/api/transactions?month=${CUR}`]: { month: CUR, transactions: fixtureListedTxns },
    "/api/auth/me": { authenticated: true, setupRequired: false, username: "owner" },
    "/api/auth/agent-tokens": {
      tokens: [{ id: 1, name: "Home server", created_at: "2026-09-02T14:10:00.000Z", last_used_at: null }],
    },
  },
} satisfies MockApiConfig;

const meta: Meta<typeof AppShell> = {
  title: "App/Shell",
  component: AppShell,
  parameters: {
    mockApi: fullApi,
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The whole app: sidebar navigation, month context, and all six tabs, with every API route mocked. Use these stories to click through the full experience and to capture screens.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof AppShell>;

async function goToTab(canvasElement: HTMLElement, label: string) {
  const aside = within(canvasElement).getByRole("complementary");
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
    await within(canvasElement).findAllByText("Rent share");
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

export const Sharing: Story = {
  parameters: {
    docs: { description: { story: "Navigating to the Sharing tab. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    await goToTab(canvasElement, "Sharing");
    await within(canvasElement).findAllByText("Alex");
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

export const Settings: Story = {
  parameters: {
    docs: { description: { story: "Navigating to the Settings tab. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    await goToTab(canvasElement, "Settings");
    await within(canvasElement).findByText("Home server");
  },
};

export const DeepLinkedTab: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Opening the app with ?tab=sharing lands on the Sharing tab instead of Overview, and switching tabs writes the new tab back to the URL. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const original = window.location.href;
    // Wait until Overview data has rendered: by then the shell's popstate
    // listener (attached in an effect) is in place.
    await within(canvasElement).findByText("Mock grocery run");
    try {
      // Simulate arriving with ?tab=sharing in the URL, the way a refresh
      // or a shared link would.
      const deep = new URL(original);
      deep.searchParams.set("tab", "sharing");
      window.history.replaceState(null, "", deep);
      window.dispatchEvent(new PopStateEvent("popstate"));
      await within(canvasElement).findAllByText("Alex");

      // Switching tabs writes the new tab back to the URL.
      await goToTab(canvasElement, "Pots");
      await within(canvasElement).findAllByText("Rent share");
      expect(new URLSearchParams(window.location.search).get("tab")).toBe("pots");
    } finally {
      // Clean up so other stories still open on Overview.
      window.history.replaceState(null, "", original);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  },
};

export const AssignFromOverview: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Ready to assign has one home per screen. On Overview it is the Assign button under the hero; tapping it lands on Pots, where the figure sits in the summary card next to Start assigning, and the close card no longer repeats it. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const original = window.location.href;
    const canvas = within(canvasElement);
    try {
      await userEvent.click(await canvas.findByRole("button", { name: /ready to assign.*Assign/ }));
      await canvas.findAllByText("Rent share");
      expect(await canvas.findByRole("button", { name: "Start assigning" })).toBeTruthy();
      expect(canvas.queryByText(/still to assign/)).toBeNull();
    } finally {
      window.history.replaceState(null, "", original);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  },
};
