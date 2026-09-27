import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { AttentionCard } from "../App";
import { fixtureAccounts, makeAttention, makeOverview } from "./fixtures";

const meta: Meta<typeof AttentionCard> = {
  title: "Overview/AttentionCard",
  component: AttentionCard,
  args: { onGo: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The needs-attention card on the overview page. It surfaces the short list that matters right now: transactions waiting for review, accounts that do not reconcile, unassigned money, and what the partner owes.",
      },
    },
  },
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
  parameters: {
    docs: {
      description: {
        story: "Every attention item present at once: review queue, unreconciled accounts, unassigned money, partner balance.",
      },
    },
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
  parameters: {
    docs: { description: { story: "Only the review queue needs work; everything else is clear." } },
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
  parameters: {
    docs: { description: { story: "Only an unsettled partner balance to surface." } },
  },
};

export const LegacyFallback: Story = {
  args: {
    ...base,
    attention: null,
    overview: makeOverview({ pendingCount: 2 }),
  },
  parameters: {
    docs: {
      description: { story: "Fallback when the attention endpoint is unavailable: falls back to the pending review count." },
    },
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
