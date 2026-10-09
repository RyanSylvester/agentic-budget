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
          "The month stepper used above the month tabs. Borderless chevrons move one month at a time, forward into future months as well as back. Away from the current month a Back to <Month> pill returns in one tap.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof MonthNav>;

export const CurrentMonth: Story = {
  args: { month: currentMonthLocal() },
  parameters: {
    docs: { description: { story: "On the current month there is no Back pill; the forward chevron opens next month for planning." } },
  },
};

export const PastMonth: Story = {
  args: { month: "2026-08" },
  parameters: {
    docs: { description: { story: "On a past month both chevrons are active, and the Back pill returns to the current month." } },
  },
};

export const FutureMonth: Story = {
  args: { month: "2027-01" },
  parameters: {
    docs: { description: { story: "Planning ahead: the Back pill returns to the current month." } },
  },
};
