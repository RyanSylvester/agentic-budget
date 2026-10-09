import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { ScaffoldSheet } from "../ScaffoldSheet";
import type { MockApiConfig } from "./mockApi";

/* Bulk-fill a future month's assignments from history. */

const now = new Date();
const FUTURE = `${now.getFullYear() + (now.getMonth() === 11 ? 1 : 0)}-${String(
  now.getMonth() === 11 ? 1 : now.getMonth() + 2
).padStart(2, "0")}`;

const lines = [
  { potId: 1, name: "Rent", cents: 300000, income: false },
  { potId: 2, name: "Groceries", cents: 105000, income: false },
  { potId: 3, name: "TFSA", cents: 75000, income: false },
];

const linesWithIncome = [
  ...lines,
  { potId: 4, name: "Pay", cents: 512000, income: true },
];

const scaffoldPost = (returned: typeof lines) => ({
  "/api/assign/scaffold": (body: unknown) => {
    const b = body as { dryRun?: boolean };
    return { ok: true, month: FUTURE, lines: b.dryRun ? returned : returned };
  },
});

const meta: Meta<typeof ScaffoldSheet> = {
  title: "Pots/ScaffoldSheet",
  component: ScaffoldSheet,
  args: { month: FUTURE, onClose: fn(), onScaffolded: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The bulk-fill sheet for a future month. Pick a strategy (3-month average or last month assigned), preview the per-pot values, then confirm. Income pots always copy last month's planned income.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ScaffoldSheet>;

export const Preview: Story = {
  parameters: {
    mockApi: { post: scaffoldPost(lines) } satisfies MockApiConfig,
    docs: { description: { story: "Strategy preview: per-pot values and the total before confirming." } },
  },
};

export const WithIncomePot: Story = {
  parameters: {
    mockApi: { post: scaffoldPost(linesWithIncome) } satisfies MockApiConfig,
    docs: { description: { story: "Income pots are marked as planned income in the preview." } },
  },
};

export const ConfirmStep: Story = {
  parameters: {
    mockApi: { post: scaffoldPost(lines) } satisfies MockApiConfig,
    docs: { description: { story: "The apply button asks for explicit confirmation. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Scaffold 3 pots/ }));
    await canvas.findByText(/overwrites any values already set/);
  },
};

export const SwitchStrategy: Story = {
  parameters: {
    mockApi: {
      post: {
        "/api/assign/scaffold": (body: unknown) => {
          const b = body as { strategy?: string };
          return {
            ok: true,
            month: FUTURE,
            lines: b.strategy === "last_month" ? lines : linesWithIncome,
          };
        },
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Switching strategy reloads the preview. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Last month" }));
    await canvas.findByText("Rent");
  },
};
