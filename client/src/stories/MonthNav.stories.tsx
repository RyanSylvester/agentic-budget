import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { MonthNav } from "../App";

const meta: Meta<typeof MonthNav> = {
  title: "Navigation/MonthNav",
  component: MonthNav,
  args: { onChange: fn() },
};

export default meta;
type Story = StoryObj<typeof MonthNav>;

// NOTE: "current month" is derived from the real clock, so the disabled
// next-button state only shows when the story month matches today.
export const CurrentMonth: Story = {
  args: { month: new Date().toISOString().slice(0, 7) },
};

export const PastMonth: Story = {
  args: { month: "2026-08" },
};
