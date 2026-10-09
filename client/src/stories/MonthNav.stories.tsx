import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { currentMonthLocal } from "../format";
import { MonthNav } from "../ui";

const meta: Meta<typeof MonthNav> = {
  title: "Navigation/MonthNav",
  component: MonthNav,
  args: { onChange: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The month stepper used above the budget table. Borderless chevrons move one month at a time, forward into future months as well as back.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof MonthNav>;

export const CurrentMonth: Story = {
  args: { month: currentMonthLocal() },
  parameters: {
    docs: { description: { story: "The forward chevron stays active on the current month, opening next month for scaffolding." } },
  },
};

export const PastMonth: Story = {
  args: { month: "2026-08" },
  parameters: {
    docs: { description: { story: "On a past month both chevrons are active." } },
  },
};
