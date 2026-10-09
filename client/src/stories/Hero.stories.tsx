import type { Meta, StoryObj } from "@storybook/react-vite";
import { Hero } from "../OverviewTab";
import { makeOverview } from "./fixtures";

const meta: Meta<typeof Hero> = {
  title: "Overview/Hero",
  component: Hero,
  parameters: {
    docs: {
      description: {
        component:
          "The overview page header. It shows the month's total spend, what's left to assign, and how much was assigned, in large serif type. Past months show their closed totals instead.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Hero>;

export const Loading: Story = {
  args: { overview: null, isCurrent: true, loading: true },
  parameters: {
    docs: { description: { story: "Skeleton state while the overview loads." } },
  },
};

export const CurrentMonth: Story = {
  args: { overview: makeOverview(), isCurrent: true },
  parameters: {
    docs: { description: { story: "The current month with money still ready to assign." } },
  },
};

export const CurrentMonthZeroRta: Story = {
  args: { overview: makeOverview({ rtaCents: 0 }), isCurrent: true },
  parameters: {
    docs: { description: { story: "Every dollar assigned: ready-to-assign reads zero, the target end-of-month state." } },
  },
};

export const PastMonth: Story = {
  args: { overview: makeOverview({ month: "2026-08", confirmedSpendCents: 198450 }), isCurrent: false },
  parameters: {
    docs: { description: { story: "A closed month shows final totals; nothing is editable." } },
  },
};

export const ZeroSpend: Story = {
  args: { overview: makeOverview({ confirmedSpendCents: 0, rtaCents: 512000 }), isCurrent: true },
  parameters: {
    docs: { description: { story: "A fresh month with no spending yet." } },
  },
};
