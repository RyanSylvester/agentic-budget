import type { Meta, StoryObj } from "@storybook/react-vite";
import { Hero } from "../App";
import { makeOverview } from "./fixtures";

const meta: Meta<typeof Hero> = {
  title: "Overview/Hero",
  component: Hero,
};

export default meta;
type Story = StoryObj<typeof Hero>;

export const Loading: Story = {
  args: { overview: null, isCurrent: true, loading: true },
};

export const CurrentMonth: Story = {
  args: { overview: makeOverview(), isCurrent: true },
};

export const CurrentMonthNoRta: Story = {
  args: { overview: makeOverview({ rtaCents: undefined, assignedCents: undefined }), isCurrent: true },
};

export const CurrentMonthZeroRta: Story = {
  args: { overview: makeOverview({ rtaCents: 0 }), isCurrent: true },
};

export const PastMonth: Story = {
  args: { overview: makeOverview({ month: "2026-08", confirmedSpendCents: 198450 }), isCurrent: false },
};

export const ZeroSpend: Story = {
  args: { overview: makeOverview({ confirmedSpendCents: 0, rtaCents: 512000 }), isCurrent: true },
};
