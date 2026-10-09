import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { OverviewTab } from "../OverviewTab";
import { SetupChecklistCard, setupSteps } from "../SetupChecklist";
import { fixtureAccounts, fixturePots, makeOverview, MONTH } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof SetupChecklistCard> = {
  title: "Overview/SetupChecklist",
  component: SetupChecklistCard,
  args: { onGo: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "First-run card at the top of Overview, shown while the user has no accounts or no pots. Each step ticks off from data the app already loads and links to the tab where it gets done.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SetupChecklistCard>;

const emptyOverview = makeOverview({ confirmedSpendCents: 0, recent: [], rtaCents: 0, assignedCents: 0 });

export const BrandNew: Story = {
  args: { steps: setupSteps({ accounts: [], pots: [], overview: emptyOverview }) },
  parameters: { docs: { description: { story: "Nothing set up yet: the first step leads." } } },
};

export const AccountAdded: Story = {
  args: {
    steps: setupSteps({
      accounts: [{ ...fixtureAccounts[0], workingBalanceCents: 0, clearedBalanceCents: 0, lastReconciledAt: null }],
      pots: [],
      overview: emptyOverview,
    }),
  },
  parameters: { docs: { description: { story: "One account in: step one ticks off and pots are next." } } },
};

export const PotsButNoAccount: Story = {
  args: { steps: setupSteps({ accounts: [], pots: fixturePots, overview: emptyOverview }) },
  parameters: { docs: { description: { story: "Pots exist (e.g. made by an agent) but there is no account yet." } } },
};

/** The full Overview for a new user: the checklist sits above the hero. */
export const InOverview: StoryObj<typeof OverviewTab> = {
  render: () => <OverviewTab month={MONTH} onGo={fn()} />,
  parameters: {
    mockApi: {
      get: {
        [`/api/overview?month=${MONTH}`]: emptyOverview,
        [`/api/pots?month=${MONTH}`]: { month: MONTH, rtaCents: 0, pots: [] },
        "/api/accounts": { accounts: [] },
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "A new user's Overview: the checklist leads, above an empty month." } },
  },
};
