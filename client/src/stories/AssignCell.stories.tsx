import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AssignCell } from "../BudgetTable";
import { makePot } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof AssignCell> = {
  title: "Budget Table/AssignCell",
  component: AssignCell,
  args: {
    pot: makePot({ name: "Groceries", assignedCents: 60000 }),
    month: "2026-09",
    onAssigned: fn(),
  },
  parameters: {
    docs: {
      description: {
        component:
          "The inline editor inside the Assigned column. Tap a value to type a new one (the old value is selected, so typing replaces it); Enter, the ✓ button, or leaving the field saves, and Escape cancels. Opening the editor fetches last month's assignment and the 3-month average as one-tap quick-fills (plus the schedule amount on sinking pots), and the field accepts math (25+30) with a live result hint.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof AssignCell>;

export const Default: Story = {
  parameters: {
    docs: { description: { story: "The resting state: the assigned amount as a button." } },
  },
};

export const PlannedIncome: Story = {
  args: {
    pot: makePot({ name: "Paycheck", assignable: false, assignedCents: 520000 }),
    purpose: "planned",
  },
  parameters: {
    docs: {
      description: {
        story:
          "On income pots the same control sets planned income rather than a budget allocation; the tooltip and screen-reader label say so.",
      },
    },
  },
};

export const CommitSucceeds: Story = {
  parameters: {
    mockApi: {
      post: { "/api/assign": { ok: true } },
    } satisfies MockApiConfig,
    docs: {
      description: { story: "Typing 750 and pressing Enter posts to the API and closes the editor. (Interaction test.)" },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Assign to Groceries/ }));
    const input = canvas.getByLabelText("Assign money to Groceries");
    await userEvent.clear(input);
    await userEvent.type(input, "750");
    await userEvent.keyboard("{Enter}");
    await expect(args.onAssigned).toHaveBeenCalled();
    // editor closes after a successful commit
    await expect(canvas.queryByLabelText("Assign money to Groceries")).toBeNull();
  },
};

export const CommitFails: Story = {
  parameters: {
    mockApi: {
      failPost: ["/api/assign"],
    } satisfies MockApiConfig,
    docs: {
      description: { story: "A failed save shows an inline error and keeps the editor open so nothing is lost." },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Assign to Groceries/ }));
    const input = canvas.getByLabelText("Assign money to Groceries");
    await userEvent.clear(input);
    await userEvent.type(input, "750");
    await userEvent.keyboard("{Enter}");
    await canvas.findByText("Couldn't save.");
  },
};

export const EscapeCancels: Story = {
  parameters: {
    docs: { description: { story: "Escape closes the editor without saving or calling back. (Interaction test.)" } },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Assign to Groceries/ }));
    const input = canvas.getByLabelText("Assign money to Groceries");
    await userEvent.type(input, "999");
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByLabelText("Assign money to Groceries")).toBeNull();
    await expect(args.onAssigned).not.toHaveBeenCalled();
  },
};

export const BlurSaves: Story = {
  parameters: {
    mockApi: {
      post: { "/api/assign": { ok: true } },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story:
          "Leaving the field with a changed amount saves it, since the iOS decimal keypad has no Return key; the new amount shows straight away. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Assign to Groceries/ }));
    // the prefilled value is selected, so typing replaces it
    await userEvent.keyboard("750");
    await userEvent.click(canvasElement.ownerDocument.body);
    await expect(args.onAssigned).toHaveBeenCalled();
    await canvas.findByRole("button", { name: /currently \$750\.00/ });
  },
};

export const SaveButton: Story = {
  parameters: {
    mockApi: {
      post: { "/api/assign": { ok: true } },
    } satisfies MockApiConfig,
    docs: { description: { story: "The ✓ button saves without a keyboard Return key. (Interaction test.)" } },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Assign to Groceries/ }));
    await userEvent.keyboard("420");
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
    await expect(args.onAssigned).toHaveBeenCalled();
  },
};

export const SinkingSchedule: Story = {
  args: {
    pot: makePot({
      name: "Car insurance",
      assignedCents: 0,
      sinking: {
        expectedCents: 120000,
        dueMonth: "2027-07",
        cadenceMonths: 12,
        contributionCents: 7500,
        balanceCents: 45000,
        remainingCents: 75000,
        monthsLeft: 10,
        state: "funding",
      },
    }),
  },
  parameters: {
    mockApi: {
      post: { "/api/assign": { ok: true } },
    } satisfies MockApiConfig,
    docs: {
      description: { story: "On a sinking pot the first quick-fill is the schedule's monthly amount." },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Assign to Car insurance/ }));
    await canvas.findByRole("button", { name: /Schedule · \$75\.00/ });
  },
};

export const QuickFill: Story = {
  args: {
    pot: makePot({ id: 7, name: "Groceries", assignedCents: 0 }),
  },
  parameters: {
    mockApi: {
      post: { "/api/assign": { ok: true } },
      get: {
        "/api/pots/7/assign-history?month=2026-09": {
          potId: 7,
          month: "2026-09",
          lastMonth: { month: "2026-08", cents: 75000 },
          avg3moCents: 80000,
        },
      },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story:
          "Opening the editor fetches last month's assignment and the 3-month average; either button saves that amount in one tap. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Assign to Groceries/ }));
    const fill = await canvas.findByRole("button", { name: /3-mo avg/ });
    await userEvent.click(fill);
    await expect(args.onAssigned).toHaveBeenCalled();
    await canvas.findByRole("button", { name: /currently \$800\.00/ });
  },
};
