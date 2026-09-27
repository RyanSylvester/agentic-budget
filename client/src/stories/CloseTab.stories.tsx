import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CloseTab } from "../App";
import { makeClosePreview, MONTH } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof CloseTab> = {
  title: "Tabs/CloseTab",
  component: CloseTab,
  args: { month: MONTH, onGo: fn() },
  parameters: {
    docs: {
      description: {
        component: "The full Close tab: the close summary card with loading and error states around it.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof CloseTab>;

const url = `/api/close-preview?month=${MONTH}`;

export const Loaded: Story = {
  parameters: {
    mockApi: { get: { [url]: makeClosePreview({ partnerOwedCents: 42180 }) } } satisfies MockApiConfig,
    docs: { description: { story: "Close preview loaded with a partner balance still owed." } },
  },
};

export const Loading: Story = {
  parameters: {
    mockApi: { get: { [url]: () => new Promise(() => {}) } } satisfies MockApiConfig,
    docs: { description: { story: "Skeleton while the close preview loads." } },
  },
};

export const Error: Story = {
  parameters: {
    mockApi: { failGet: [url] } satisfies MockApiConfig,
    docs: { description: { story: "The shared error card with retry when the preview fails to load." } },
  },
};
