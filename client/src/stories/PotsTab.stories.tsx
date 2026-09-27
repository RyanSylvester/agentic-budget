import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { PotsTab } from "../App";
import { fixtureContacts, fixturePots, fixtureTrend, MONTH } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof PotsTab> = {
  title: "Tabs/PotsTab",
  component: PotsTab,
  args: { month: MONTH },
  parameters: {
    docs: {
      description: {
        component: "The full Pots tab: the month summary card, then the budget table, with loading, error, and empty states around them.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PotsTab>;

const url = `/api/pots?month=${MONTH}`;
const trend = { "/api/trend": { trend: fixtureTrend } };

export const Loaded: Story = {
  parameters: {
    mockApi: { get: { [url]: { pots: fixturePots, rtaCents: 8633 }, ...trend } } satisfies MockApiConfig,
    docs: { description: { story: "Pots loaded for the month, with the summary card on top." } },
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
    mockApi: { get: { [url]: { pots: [], rtaCents: 503394 }, ...trend } } satisfies MockApiConfig,
    docs: { description: { story: "No pots for the month." } },
  },
};

export const AddPotFlow: Story = {
  parameters: {
    mockApi: {
      get: {
        [url]: { pots: fixturePots, rtaCents: 8633 },
        ...trend,
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
