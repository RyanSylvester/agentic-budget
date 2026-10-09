import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { PotsSummary, SpendInsights } from "../PotsTab";
import { fixturePlannedPots, fixturePots, fixtureTrend, MONTH } from "./fixtures";

const plannedAssigned = fixturePlannedPots.reduce((a, p) => a + (p.assignable ? p.assignedCents : 0), 0);

const meta: Meta<typeof PotsSummary> = {
  title: "Tabs/PotsSummary",
  component: PotsSummary,
  args: { month: MONTH, pots: fixturePots, rtaCents: 8633, planning: "current", onAssign: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The first card on the Pots page, straight above the budget table: ready to assign (its one home on this screen, with a Start assigning action). While a month's income is still planned rather than received, it shows what is left to plan against planned income instead, in neutral tones.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PotsSummary>;

export const Typical: Story = {
  parameters: {
    docs: { description: { story: "Money in and waiting for a job." } },
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
    docs: { description: { story: "Real inflows that the assignments exceed: the figure turns to the danger tone." } },
  },
};

export const FuturePlanning: Story = {
  args: { pots: fixturePlannedPots, rtaCents: -plannedAssigned, planning: "future" },
  parameters: {
    docs: {
      description: {
        story: "A future month has no inflows: planned income minus assigned, never a red over-assigned figure.",
      },
    },
  },
};

export const FuturePlannedBeyondIncome: Story = {
  args: {
    pots: fixturePlannedPots.map((p) => (p.name === "Paycheck" ? { ...p, assignedCents: 450000 } : p)),
    rtaCents: -plannedAssigned,
    planning: "future",
  },
  parameters: {
    docs: { description: { story: "Assignments above planned income: still neutral, worded as more than planned." } },
  },
};

export const PayOnTheWay: Story = {
  args: { pots: fixturePlannedPots, rtaCents: 200000 - plannedAssigned, planning: "current" },
  parameters: {
    docs: { description: { story: "This month, with only part of the planned income received so far." } },
  },
};

export const NothingAssigned: Story = {
  args: {
    pots: fixturePots.map((p) => ({ ...p, assignedCents: 0 })),
    rtaCents: 0,
    planning: "current",
    onFill: fn(),
  },
  parameters: {
    docs: { description: { story: "Nothing assigned or planned yet: Fill from history is the action." } },
  },
};

export const Insights: StoryObj<typeof SpendInsights> = {
  render: () => <SpendInsights month={MONTH} pots={fixturePots} trend={fixtureTrend} />,
  parameters: {
    docs: { description: { story: "Below the table: the top three spending groups and the six-month sparkline." } },
  },
};

export const InsightsSingleMonth: StoryObj<typeof SpendInsights> = {
  render: () => <SpendInsights month={MONTH} pots={fixturePots} trend={[{ month: "2026-09", spent: 272123 }]} />,
  parameters: {
    docs: { description: { story: "One month of history is not a trend: no sparkline." } },
  },
};

export const Overspent: Story = {
  args: { overspent: { count: 2, cents: 8410 }, onShowOverspent: fn() },
  parameters: {
    docs: { description: { story: "Pots overspent this month: a red line under the figure, whose Show action leads to the first overspent row." } },
  },
};
