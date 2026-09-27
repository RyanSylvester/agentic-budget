import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { AttentionCard } from "../App";
import { fixtureAccounts, makeAttention, makeOverview } from "./fixtures";

const meta: Meta<typeof AttentionCard> = {
  title: "Overview/AttentionCard",
  component: AttentionCard,
  args: { onGo: fn() },
};

export default meta;
type Story = StoryObj<typeof AttentionCard>;

const base = {
  overview: makeOverview(),
  accounts: fixtureAccounts,
  onGo: fn(),
};

export const AllItems: Story = {
  args: {
    ...base,
    attention: makeAttention({ unsettledPartnerCents: 42180 }),
  },
};

export const ReviewOnly: Story = {
  args: {
    ...base,
    attention: makeAttention({
      pendingReviewCount: 1,
      unreconciledAccounts: [],
      rtaCents: 0,
      unsettledPartnerCents: 0,
    }),
  },
};

export const PartnerOwesOnly: Story = {
  args: {
    ...base,
    attention: makeAttention({
      pendingReviewCount: 0,
      unreconciledAccounts: [],
      rtaCents: 0,
      unsettledPartnerCents: 129900,
    }),
  },
};

export const LegacyFallback: Story = {
  args: {
    ...base,
    attention: null,
    overview: makeOverview({ pendingCount: 2 }),
  },
};

export const NothingToShow: Story = {
  args: {
    ...base,
    attention: makeAttention({
      pendingReviewCount: 0,
      unreconciledAccounts: [],
      rtaCents: 0,
      unsettledPartnerCents: 0,
    }),
  },
  parameters: {
    docs: {
      description: {
        story: "Renders nothing when there is nothing to surface.",
      },
    },
  },
};
