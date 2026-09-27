import type { Meta, StoryObj } from "@storybook/react-vite";
import { PotsTab } from "../App";
import { fixturePots, MONTH } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof PotsTab> = {
  title: "Tabs/PotsTab",
  component: PotsTab,
  args: { month: MONTH },
};

export default meta;
type Story = StoryObj<typeof PotsTab>;

const url = `/api/pots?month=${MONTH}`;

export const Loaded: Story = {
  parameters: {
    mockApi: { get: { [url]: { pots: fixturePots } } } satisfies MockApiConfig,
  },
};

export const Loading: Story = {
  parameters: {
    mockApi: { get: { [url]: () => new Promise(() => {}) } } satisfies MockApiConfig,
  },
};

export const Error: Story = {
  parameters: {
    mockApi: { failGet: [url] } satisfies MockApiConfig,
  },
};

export const Empty: Story = {
  parameters: {
    mockApi: { get: { [url]: { pots: [] } } } satisfies MockApiConfig,
  },
};
