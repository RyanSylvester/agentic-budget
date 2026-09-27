import type { Meta, StoryObj } from "@storybook/react-vite";
import { RecentActivity } from "../App";
import { fixtureTxns, makeTxn } from "./fixtures";

const meta: Meta<typeof RecentActivity> = {
  title: "Overview/RecentActivity",
  component: RecentActivity,
};

export default meta;
type Story = StoryObj<typeof RecentActivity>;

export const Mixed: Story = {
  args: { txns: fixtureTxns },
  parameters: {
    docs: {
      description: {
        story: "Transfers are filtered out; splits show a 'split' marker; income renders green.",
      },
    },
  },
};

export const Loading: Story = {
  args: { txns: [], loading: true },
};

export const Empty: Story = {
  args: { txns: [] },
};

export const OnlyTransfers: Story = {
  args: {
    txns: [
      makeTxn({ description: "Mock transfer out", user_cents: -89182, is_transfer: 1 }),
      makeTxn({ description: "Mock transfer in", user_cents: 89182, is_transfer: 1 }),
    ],
  },
  parameters: {
    docs: {
      description: { story: "A feed of pure transfers reads as empty: net-zero noise is hidden." },
    },
  },
};

export const LongDescriptions: Story = {
  args: {
    txns: [
      makeTxn({ description: "Mock purchase with a very long description that should truncate gracefully in the row" }),
    ],
  },
};
