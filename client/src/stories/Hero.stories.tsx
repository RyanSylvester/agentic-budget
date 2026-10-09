import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Hero } from "../OverviewTab";
import { makeOverview } from "./fixtures";

const meta: Meta<typeof Hero> = {
  title: "Overview/Hero",
  component: Hero,
  args: { onAssign: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The overview page header. It shows the month's total spend in large light type, the daily pace, and ready-to-assign. Ready to assign appears only here on Overview: with money waiting it is an Assign button that jumps to Pots. Past months show their closed totals instead.",
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
    docs: { description: { story: "The current month with money still ready to assign: the line is a button that goes to Pots." } },
  },
};

export const CurrentMonthZeroRta: Story = {
  args: { overview: makeOverview({ rtaCents: 0 }), isCurrent: true },
  parameters: {
    docs: { description: { story: "Every dollar assigned: the line settles into a quiet confirmation with no action." } },
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

export const CurrentMonthOverAssigned: Story = {
  args: { overview: makeOverview({ rtaCents: -4250 }), isCurrent: true },
  parameters: {
    docs: { description: { story: "More assigned than came in: the line turns to the danger tone and offers a fix in Pots." } },
  },
};

export const WithoutAction: Story = {
  args: { overview: makeOverview(), isCurrent: true, onAssign: undefined },
  parameters: {
    docs: { description: { story: "Without an onAssign handler the line renders as plain text." } },
  },
};
