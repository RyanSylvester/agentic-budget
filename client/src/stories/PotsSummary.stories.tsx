import type { Meta, StoryObj } from "@storybook/react-vite";
import { PotsSummary } from "../App";
import { fixturePots, fixtureTrend, MONTH } from "./fixtures";

const meta: Meta<typeof PotsSummary> = {
  title: "Tabs/PotsSummary",
  component: PotsSummary,
  args: { month: MONTH, pots: fixturePots, rtaCents: 8633, trend: fixtureTrend },
  parameters: {
    docs: {
      description: {
        component:
          "The compact month summary at the top of the Pots page: spend and ready-to-assign, the top three spending groups, and a six-month sparkline. This replaces the old Insights tab.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PotsSummary>;

export const Typical: Story = {
  parameters: {
    docs: { description: { story: "A normal month: spend, ready-to-assign, top groups, and the trend." } },
  },
};

export const NoSpending: Story = {
  args: { pots: [], rtaCents: 503394, trend: [] },
  parameters: {
    docs: { description: { story: "A fresh month with nothing spent yet: the summary collapses to a single line." } },
  },
};

export const NoTrend: Story = {
  args: { trend: [] },
  parameters: {
    docs: { description: { story: "Spend and group numbers without six months of history: no sparkline." } },
  },
};

export const SingleGroup: Story = {
  args: { pots: fixturePots.filter((p) => p.group === "Food") },
  parameters: {
    docs: { description: { story: "Only one spending group: the top-groups list stays short." } },
  },
};
