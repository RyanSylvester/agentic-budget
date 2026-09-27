import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CloseTab } from "../App";
import { makeClosePreview, MONTH } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof CloseTab> = {
  title: "Tabs/CloseTab",
  component: CloseTab,
  args: { month: MONTH, onGo: fn() },
};

export default meta;
type Story = StoryObj<typeof CloseTab>;

const url = `/api/close-preview?month=${MONTH}`;

export const Loaded: Story = {
  parameters: {
    mockApi: { get: { [url]: makeClosePreview({ partnerOwedCents: 42180 }) } } satisfies MockApiConfig,
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
