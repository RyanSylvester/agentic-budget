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
  parameters: {
    docs: {
      description: {
        component:
          "The heart of the Pots tab: every pot in a month grouped by category, with Assigned, Spent, and Available columns. Groups collapse; clicking an Assigned cell edits it inline.",
      },
    },
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
          "Group containers with summed totals, 50% and contact-share tags, an overspent pot (red Available), income section at the bottom.",
      },
    },
  },
};

export const CollapseGroup: Story = {
  args: { pots: fixturePots },
  parameters: {
    docs: {
      description: {
        story: "Clicking a group header collapses its pots; the group totals stay visible. (Interaction test: clicks the header.)",
      },
    },
  },
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
  parameters: {
    docs: { description: { story: "No pots at all: the table renders its empty state." } },
  },
};

export const IncomeOnly: Story = {
  args: {
    pots: [
      makePot({ name: "Paycheck", group: "Income", assignable: false }),
      makePot({ name: "Interest", group: "Income", assignable: false }),
    ],
  },
  parameters: {
    docs: { description: { story: "Income pots are listed separately at the bottom and cannot be assigned to." } },
  },
};

export const SinglePot: Story = {
  args: {
    pots: [makePot({ name: "Groceries", group: "Food", targetCents: 60000, spentCents: 55263, assignedCents: 60000 })],
  },
  parameters: {
    docs: { description: { story: "A single pot row: Assigned, Spent, Available with an inline editor." } },
  },
};
