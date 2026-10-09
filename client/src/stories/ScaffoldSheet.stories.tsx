import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { ScaffoldSheet } from "../ScaffoldSheet";
import { fixturePots } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

/* Fill a month's assignments from history. */

const now = new Date();
const FUTURE = `${now.getFullYear() + (now.getMonth() === 11 ? 1 : 0)}-${String(
  now.getMonth() === 11 ? 1 : now.getMonth() + 2
).padStart(2, "0")}`;

const [rent, groceries, , , dining, , , , buffer, pay] = fixturePots;
const lines = [
  { potId: rent.id, name: rent.name, cents: 172000, income: false },
  { potId: groceries.id, name: groceries.name, cents: 58500, income: false },
  { potId: dining.id, name: dining.name, cents: 21000, income: false },
  { potId: buffer.id, name: buffer.name, cents: 228500, income: false },
];

const linesWithIncome = [
  ...lines,
  { potId: pay.id, name: pay.name, cents: 512000, income: true },
];

/* The month as loaded: what each pot holds now, for "current -> new". */
const currentPots = fixturePots.map((p) => (p.id === pay.id ? { ...p, assignedCents: 500000 } : p));

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
          "Fill from history: the bulk-fill sheet for a future month, or the current month before anything is assigned. Pick a strategy (3-month average or last month assigned), preview the per-pot values against what is set now, then confirm. Planned income is listed apart and the total counts only assignable pots, against planned income.",
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
  args: { pots: currentPots },
  parameters: {
    mockApi: { post: scaffoldPost(linesWithIncome) } satisfies MockApiConfig,
    docs: { description: { story: "With the month's pots passed in, rows that change show current → new, and the total reads against planned income." } },
  },
};

export const ConfirmStep: Story = {
  parameters: {
    mockApi: { post: scaffoldPost(lines) } satisfies MockApiConfig,
    docs: { description: { story: "The apply button asks for explicit confirmation. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Fill 4 pots/ }));
    await canvas.findByText(/replaces any values already set/);
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

export const PreviewFails: Story = {
  parameters: {
    mockApi: { failPost: ["/api/assign/scaffold"] } satisfies MockApiConfig,
    docs: { description: { story: "The preview could not be computed: a retry card, and the fill button stays disabled." } },
  },
};

export const ApplyFails: Story = {
  parameters: {
    mockApi: {
      post: {
        "/api/assign/scaffold": (body: unknown) =>
          (body as { dryRun?: boolean }).dryRun
            ? { ok: true, month: FUTURE, lines: linesWithIncome }
            : new Response(JSON.stringify({ error: "bad month" }), { status: 400, headers: { "content-type": "application/json" } }),
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Saving failed: the preview stays, with its own error under the buttons. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Fill 4 pots/ }));
    await userEvent.click(await canvas.findByRole("button", { name: "Fill now" }));
    await canvas.findByText(/Couldn't save these amounts/);
  },
};
