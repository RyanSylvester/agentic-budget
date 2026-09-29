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
          "Group containers with summed totals, each header showing its share of total spend next to the spent figure (66/28/6/0 here), 50% and contact-share tags, an overspent pot (red Available), income section at the bottom.",
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
    docs: { description: { story: "Income pots are listed separately at the bottom. They are assignable: the planned cell records expected income for the month." } },
  },
};

export const IncomePlannedVsReceived: Story = {
  args: {
    pots: [
      makePot({ name: "Paycheck", group: "Income", assignable: false, assignedCents: 520000, receivedCents: 500000 }),
      makePot({ name: "Interest", group: "Income", assignable: false, assignedCents: 1200, receivedCents: 1200 }),
      makePot({ name: "Side gig", group: "Income", assignable: false, assignedCents: 0, receivedCents: 80000 }),
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          "Each income pot shows planned income (editable, via the planned cell) next to received (what has actually landed). Paycheck is short of plan, Interest matches its plan, and Side gig arrived with no plan set. Planned income never counts toward ready to assign.",
      },
    },
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

export const ShareOfSpend: Story = {
  args: { pots: fixturePots },
  parameters: {
    docs: {
      description: {
        story:
          "Each group header shows its share of total spend next to the spent figure: Joint Living 66%, Food 28%, Transport 6%, Savings 0%. Income pots never count toward the total. (Interaction test: asserts the rendered percentages.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(within(canvas.getByRole("button", { name: /Joint Living/ })).getByText("· 66%")).toBeInTheDocument();
    await expect(within(canvas.getByRole("button", { name: /Food/ })).getByText("· 28%")).toBeInTheDocument();
    await expect(within(canvas.getByRole("button", { name: /Transport/ })).getByText("· 6%")).toBeInTheDocument();
    await expect(within(canvas.getByRole("button", { name: /Savings/ })).getByText("· 0%")).toBeInTheDocument();
  },
};

export const ShareOfSpendEdges: Story = {
  args: {
    pots: [
      makePot({ name: "Rent", group: "Housing", spentCents: 200000, assignedCents: 200000 }),
      makePot({ name: "Gum", group: "Tiny", spentCents: 50, assignedCents: 100 }),
      makePot({ name: "Buffer", group: "Savings", spentCents: 0, assignedCents: 50000 }),
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          "Edge cases: a nonzero sliver of total spend reads <1%, a group with no spend reads 0%. When nothing was spent at all, no percentage is shown. (Interaction test: asserts the edge-case labels.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(within(canvas.getByRole("button", { name: /Housing/ })).getByText("· 100%")).toBeInTheDocument();
    await expect(within(canvas.getByRole("button", { name: /Tiny/ })).getByText("· <1%")).toBeInTheDocument();
    await expect(within(canvas.getByRole("button", { name: /Savings/ })).getByText("· 0%")).toBeInTheDocument();
  },
};

export const ShareOfSpendNone: Story = {
  args: { pots: [makePot({ name: "Buffer", group: "Savings", spentCents: 0, assignedCents: 50000 })] },
  parameters: {
    docs: { description: { story: "With no spend in the month, group headers show no percentage at all." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = canvas.getByRole("button", { name: /Savings/ });
    await expect(within(header).queryByText(/·/)).toBeNull();
  },
};
