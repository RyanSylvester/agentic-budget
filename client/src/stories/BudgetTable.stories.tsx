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
          "Group containers with summed totals; each header leads with a prominent assigned total and a share-of-assigned percentage pill (57/25/4/14 here), 50% and contact-share tags, an overspent pot (red Available), income section at the bottom.",
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

export const ShareOfAssigned: Story = {
  args: { pots: fixturePots },
  parameters: {
    docs: {
      description: {
        story:
          "Each group header leads with a prominent assigned total (thousand separators) and a share-of-assigned percentage pill: Joint Living $1,950.00 and 57%, Food $850.00 and 25%, Transport $150.00 and 4%, Savings $500.00 and 14%. The word 'assigned' appears nowhere visible; the pill plus the desktop 'Assigned' column header carry the meaning, while screen readers hear the full assigned label. Income pots never count toward the total. (Interaction test: asserts the rendered figures, pills, and accessible names.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const jl = within(canvas.getByRole("button", { name: /Joint Living/ }));
    await expect(jl.getByText("$1,950.00")).toBeInTheDocument();
    await expect(jl.getByText("57%")).toBeInTheDocument();
    const food = within(canvas.getByRole("button", { name: /Food/ }));
    await expect(food.getByText("$850.00")).toBeInTheDocument();
    await expect(food.getByText("25%")).toBeInTheDocument();
    const transport = within(canvas.getByRole("button", { name: /Transport/ }));
    await expect(transport.getByText("$150.00")).toBeInTheDocument();
    await expect(transport.getByText("4%")).toBeInTheDocument();
    const savings = within(canvas.getByRole("button", { name: /Savings/ }));
    await expect(savings.getByText("$500.00")).toBeInTheDocument();
    await expect(savings.getByText("14%")).toBeInTheDocument();
    // Screen-reader rescue: the accessible name restores the word "assigned".
    await expect(
      canvas.getByRole("button", { name: /Joint Living: \$1,950\.00 assigned, 57% of total assigned/ })
    ).toBeInTheDocument();
  },
};

export const ShareOfAssignedMobile: Story = {
  args: { pots: fixturePots },
  parameters: {
    viewport: {
      viewports: {
        iphone390: { name: "iPhone 14 (390px)", styles: { width: "390px", height: "844px" } },
      },
      defaultViewport: "iphone390",
    },
    docs: {
      description: {
        story:
          "The prominent header at a 390px phone width: the $1,950.00 figure and 57% pill stay on one line with no wrap or overflow while the group name truncates. (Interaction test: asserts the figure and pill render.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = within(canvas.getByRole("button", { name: /Joint Living/ }));
    await expect(header.getByText("$1,950.00")).toBeInTheDocument();
    await expect(header.getByText("57%")).toBeInTheDocument();
  },
};

export const ShareOfAssignedEdges: Story = {
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
          "Edge cases: a nonzero sliver of total assigned reads <1% in its pill. Housing shows 80%, Tiny <1%, Savings 20%. (Interaction test: asserts the edge-case labels.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(within(canvas.getByRole("button", { name: /Housing/ })).getByText("80%")).toBeInTheDocument();
    await expect(within(canvas.getByRole("button", { name: /Tiny/ })).getByText("<1%")).toBeInTheDocument();
    await expect(within(canvas.getByRole("button", { name: /Savings/ })).getByText("20%")).toBeInTheDocument();
  },
};

export const ShareOfAssignedNone: Story = {
  args: { pots: [makePot({ name: "Buffer", group: "Savings", spentCents: 0, assignedCents: 0 })] },
  parameters: {
    docs: { description: { story: "With nothing assigned in the month, group headers show a muted $0.00 and no percentage pill at all." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = within(canvas.getByRole("button", { name: /Savings/ }));
    await expect(header.getByText("$0.00")).toBeInTheDocument();
    await expect(header.queryByText(/%/)).toBeNull();
  },
};
