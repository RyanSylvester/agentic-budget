import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { PotsTab } from "../PotsTab";
import { fixtureContacts, fixturePots, fixtureTrend, makeClosePreview, MONTH } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const now = new Date();
const FUTURE = `${now.getFullYear() + (now.getMonth() === 11 ? 1 : 0)}-${String(
  now.getMonth() === 11 ? 1 : now.getMonth() + 2
).padStart(2, "0")}`;

const meta: Meta<typeof PotsTab> = {
  title: "Tabs/PotsTab",
  component: PotsTab,
  args: { month: MONTH },
  parameters: {
    docs: {
      description: {
        component: "The full Pots tab: the close card, then the month summary, then the budget table, with loading, error, and empty states around them.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PotsTab>;

const url = `/api/pots?month=${MONTH}`;
const trend = { "/api/trend": { trend: fixtureTrend } };
const closePreview = { [`/api/close-preview?month=${MONTH}`]: makeClosePreview() };

export const Loaded: Story = {
  parameters: {
    mockApi: { get: { [url]: { pots: fixturePots, rtaCents: 8633 }, ...trend, ...closePreview } } satisfies MockApiConfig,
    docs: { description: { story: "Pots loaded for the month, with the close card and summary on top." } },
  },
};

export const Loading: Story = {
  parameters: {
    mockApi: { get: { [url]: () => new Promise(() => {}) } } satisfies MockApiConfig,
    docs: { description: { story: "Skeleton table while pots load." } },
  },
};

export const Error: Story = {
  parameters: {
    mockApi: { failGet: [url] } satisfies MockApiConfig,
    docs: { description: { story: "The shared error card with retry." } },
  },
};

export const Empty: Story = {
  parameters: {
    mockApi: { get: { [url]: { pots: [], rtaCents: 487250 }, ...trend, ...closePreview } } satisfies MockApiConfig,
    docs: { description: { story: "No pots for the month." } },
  },
};

export const AddPotFlow: Story = {
  parameters: {
    mockApi: {
      get: {
        [url]: { pots: fixturePots, rtaCents: 8633 },
        ...trend,
        ...closePreview,
        "/api/contacts": { contacts: fixtureContacts },
      },
      post: { "/api/pots": { ok: true, id: 999 } },
    } satisfies MockApiConfig,
    docs: { description: { story: "The Add pot button opens the pot editor sheet. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Add pot" }));
    await canvas.findByLabelText("Name");
  },
};

const futureUrl = `/api/pots?month=${FUTURE}`;

export const FutureMonth: Story = {
  args: { month: FUTURE },
  parameters: {
    mockApi: {
      get: {
        [futureUrl]: { pots: fixturePots.map((p) => ({ ...p, assignedCents: 0, spentCents: 0 })), rtaCents: 0 },
        ...trend,
      },
      post: {
        "/api/assign/scaffold": {
          ok: true,
          month: FUTURE,
          lines: [
            { potId: 1, name: "Rent", cents: 300000, income: false },
            { potId: 2, name: "Groceries", cents: 105000, income: false },
          ],
        },
      },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story: "A future month with no data yet: zeroed numbers, no close card, and the Scaffold month button.",
      },
    },
  },
};

export const FutureMonthScaffoldFlow: Story = {
  args: { month: FUTURE },
  parameters: {
    mockApi: {
      get: {
        [futureUrl]: { pots: fixturePots.map((p) => ({ ...p, assignedCents: 0, spentCents: 0 })), rtaCents: 0 },
        ...trend,
      },
      post: {
        "/api/assign/scaffold": {
          ok: true,
          month: FUTURE,
          lines: [
            { potId: 1, name: "Rent", cents: 300000, income: false },
            { potId: 2, name: "Groceries", cents: 105000, income: false },
          ],
        },
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Scaffold month opens the bulk-fill sheet. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Scaffold month" }));
    await canvas.findByText("3-month average");
  },
};
