import type { Meta, StoryObj } from "@storybook/react-vite";
import { PotsTab } from "../App";
import { fixturePots, MONTH } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof PotsTab> = {
  title: "Tabs/PotsTab",
  component: PotsTab,
  args: { month: MONTH },
  parameters: {
    docs: {
      description: {
        component: "The full Pots tab: the budget table with loading, error, and empty states around it.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PotsTab>;

const url = `/api/pots?month=${MONTH}`;

export const Loaded: Story = {
  parameters: {
    mockApi: { get: { [url]: { pots: fixturePots } } } satisfies MockApiConfig,
    docs: { description: { story: "Pots loaded for the month." } },
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
    mockApi: { get: { [url]: { pots: [] } } } satisfies MockApiConfig,
    docs: { description: { story: "No pots for the month." } },
  },
};
