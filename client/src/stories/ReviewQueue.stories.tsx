import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ReviewQueue } from "../App";
import { fixtureReviewTxns } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof ReviewQueue> = {
  title: "Review/ReviewQueue",
  component: ReviewQueue,
  args: { onChange: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "Transactions the app could not categorize on its own. Confirm each one to file it; confirmed rows leave the queue.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ReviewQueue>;

const list = { transactions: fixtureReviewTxns };

export const Items: Story = {
  parameters: {
    mockApi: { get: { "/api/review": list } } satisfies MockApiConfig,
    docs: { description: { story: "Two transactions waiting for review." } },
  },
};

export const Empty: Story = {
  parameters: {
    mockApi: { get: { "/api/review": { transactions: [] } } } satisfies MockApiConfig,
    docs: { description: { story: "Queue clear: the empty state." } },
  },
};

export const Loading: Story = {
  parameters: {
    mockApi: { get: { "/api/review": () => new Promise(() => {}) } } satisfies MockApiConfig,
    docs: { description: { story: "Skeleton rows while the queue loads." } },
  },
};

export const Error: Story = {
  parameters: {
    mockApi: { failGet: ["/api/review"] } satisfies MockApiConfig,
    docs: { description: { story: "The shared error card with retry." } },
  },
};

export const ConfirmFlow: Story = {
  parameters: {
    mockApi: {
      get: { "/api/review": list },
      post: { "/api/review/101/confirm": { ok: true } },
    } satisfies MockApiConfig,
    docs: {
      description: { story: "Confirming a transaction files it and removes the row. (Interaction test.)" },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByText("Mock ambiguous charge");
    const item = row.closest("li")!;
    await userEvent.click(within(item).getByRole("button", { name: "Confirm" }));
    await expect(args.onChange).toHaveBeenCalled();
    // confirmed rows leave the queue
    await expect(canvas.queryByText("Mock ambiguous charge")).toBeNull();
    await expect(canvas.getByText("Mock subscription renewal")).toBeInTheDocument();
  },
};
