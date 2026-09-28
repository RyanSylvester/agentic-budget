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
          "The needs-attention card on the overview page. It surfaces the short list that matters right now: accounts that do not reconcile, unassigned money, and outstanding shared balances.",
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
    attention: makeAttention({ unsettledSharedCents: 42180, sharedOwedBy: [{ contactId: 1, name: "Alex", cents: 42180 }] }),
  },
  parameters: {
    docs: {
      description: {
        story: "Every attention item present at once: unreconciled accounts, unassigned money, shared balance.",
      },
    },
  },
};

export const SharedOwesOnly: Story = {
  args: {
    ...base,
    attention: makeAttention({
      unreconciledAccounts: [],
      rtaCents: 0,
      unsettledSharedCents: 129900,
      sharedOwedBy: [
        { contactId: 1, name: "Alex", cents: 89900 },
        { contactId: 2, name: "Sam", cents: 40000 },
      ],
    }),
  },
  parameters: {
    docs: { description: { story: "Only unsettled shared balances to surface; with two contacts owing, the card shows the total." } },
  },
};

export const SingleContactOwes: Story = {
  args: {
    ...base,
    attention: makeAttention({
      unreconciledAccounts: [],
      rtaCents: 0,
      unsettledSharedCents: 89900,
      sharedOwedBy: [{ contactId: 1, name: "Alex", cents: 89900 }],
    }),
  },
  parameters: {
    docs: { description: { story: "One contact owing reads as \"{name} owes $X\" and jumps to the Sharing tab." } },
  },
};

export const NothingToShow: Story = {
  args: {
    ...base,
    attention: makeAttention({
      unreconciledAccounts: [],
      rtaCents: 0,
      unsettledSharedCents: 0,
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
