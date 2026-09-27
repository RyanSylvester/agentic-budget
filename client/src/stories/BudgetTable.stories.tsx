import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { BudgetTable } from "../App";
import { fixturePots, makePot } from "./fixtures";

const meta: Meta<typeof BudgetTable> = {
  title: "Budget Table/BudgetTable",
  component: BudgetTable,
  args: {
    month: "2026-09",
    onAssigned: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof BudgetTable>;

export const Full: Story = {
  args: { pots: fixturePots },
  parameters: {
    docs: {
      description: {
        story:
          "Group containers with summed totals, 50% and partner-share tags, an overspent pot (red Available), income section at the bottom.",
      },
    },
  },
};

export const CollapseGroup: Story = {
  args: { pots: fixturePots },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = canvas.getByRole("button", { name: /Joint Living/ });
    await userEvent.click(header);
    // children hide; the group total stays visible
    await expect(canvas.queryByText("Rent share")).toBeNull();
    await expect(header).toBeInTheDocument();
  },
};

export const Empty: Story = {
  args: { pots: [] },
};

export const IncomeOnly: Story = {
  args: {
    pots: [
      makePot({ name: "Paycheck", group: "Income", assignable: false }),
      makePot({ name: "Interest", group: "Income", assignable: false }),
    ],
  },
};

export const SinglePot: Story = {
  args: {
    pots: [makePot({ name: "Groceries", group: "Food", targetCents: 60000, spentCents: 55263, assignedCents: 60000 })],
  },
};
