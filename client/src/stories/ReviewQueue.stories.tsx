import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ReviewQueue } from "../App";
import { fixtureReviewTxns } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof ReviewQueue> = {
  title: "Review/ReviewQueue",
  component: ReviewQueue,
  args: { onChange: fn() },
};

export default meta;
type Story = StoryObj<typeof ReviewQueue>;

const list = { transactions: fixtureReviewTxns };

export const Items: Story = {
  parameters: {
    mockApi: { get: { "/api/review": list } } satisfies MockApiConfig,
  },
};

export const Empty: Story = {
  parameters: {
    mockApi: { get: { "/api/review": { transactions: [] } } } satisfies MockApiConfig,
  },
};

export const Loading: Story = {
  parameters: {
    mockApi: { get: { "/api/review": () => new Promise(() => {}) } } satisfies MockApiConfig,
  },
};

export const Error: Story = {
  parameters: {
    mockApi: { failGet: ["/api/review"] } satisfies MockApiConfig,
  },
};

export const ConfirmFlow: Story = {
  parameters: {
    mockApi: {
      get: { "/api/review": list },
      post: { "/api/review/101/confirm": { ok: true } },
    } satisfies MockApiConfig,
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
