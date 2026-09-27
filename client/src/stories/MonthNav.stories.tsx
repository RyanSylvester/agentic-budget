import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { MonthNav } from "../App";

const meta: Meta<typeof MonthNav> = {
  title: "Navigation/MonthNav",
  component: MonthNav,
  args: { onChange: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The month stepper used above the budget table. Borderless chevrons move one month at a time; the forward chevron disables on the current month.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof MonthNav>;

// NOTE: "current month" is derived from the real clock, so the disabled
// next-button state only shows when the story month matches today.
export const CurrentMonth: Story = {
  args: { month: new Date().toISOString().slice(0, 7) },
  parameters: {
    docs: { description: { story: "On the current month the forward chevron is disabled." } },
  },
};

export const PastMonth: Story = {
  args: { month: "2026-08" },
  parameters: {
    docs: { description: { story: "On a past month both chevrons are active." } },
  },
};
