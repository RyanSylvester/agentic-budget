import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { PotsSummary } from "../PotsTab";
import { fixturePots, fixtureTrend, MONTH } from "./fixtures";

const meta: Meta<typeof PotsSummary> = {
  title: "Tabs/PotsSummary",
  component: PotsSummary,
  args: { month: MONTH, pots: fixturePots, rtaCents: 8633, trend: fixtureTrend, onAssign: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The compact month summary on the Pots page: ready-to-assign (its one home on this screen, with a Start assigning action that scrolls to the Assigned column), the top three spending groups, and a six-month sparkline.",
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
  args: { pots: [], rtaCents: 487250, trend: [] },
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

export const SingleMonthTrend: Story = {
  args: { trend: [{ month: "2026-09", spent: 272123 }] },
  parameters: {
    docs: {
      description: {
        story:
          "One month of history is not a trend: the sparkline stays hidden instead of rendering a single black bar.",
      },
    },
  },
};

export const SingleGroup: Story = {
  args: { pots: fixturePots.filter((p) => p.group === "Food") },
  parameters: {
    docs: { description: { story: "Only one spending group: the top-groups list stays short." } },
  },
};

export const AllAssigned: Story = {
  args: { rtaCents: 0 },
  parameters: {
    docs: { description: { story: "Ready to assign at $0: neutral figure, a short confirmation, no action button." } },
  },
};

export const OverAssigned: Story = {
  args: { rtaCents: -4250 },
  parameters: {
    docs: { description: { story: "More assigned than came in: the figure turns to the danger tone with guidance to lower an amount." } },
  },
};
