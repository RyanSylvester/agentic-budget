import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CloseSummaryCard } from "../PotsTab";
import { makeClosePreview } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

/* The month close card: Income, Spend, and Savings, which net to zero. */

const CUR = new Date().toISOString().slice(0, 7);
const PAST = "2026-08";

const meta: Meta<typeof CloseSummaryCard> = {
  title: "Close/CloseSummaryCard",
  component: CloseSummaryCard,
  args: { month: CUR, onClosed: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The high-level month view at the top of the Pots tab. Income minus Spend minus Savings always nets to zero; on the current month the close action is offered once ready-to-assign is $0. Past months are read-only, and the card hides on future months.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof CloseSummaryCard>;

export const Balanced: Story = {
  parameters: {
    mockApi: {
      get: {
        [`/api/close-preview?month=${CUR}`]: makeClosePreview({
          month: CUR,
          rtaBeforeCents: 0,
          movedToSavingsCents: 0,
          closed: false,
        }),
      },
    } satisfies MockApiConfig,
    docs: {
      description: { story: "Every dollar assigned: the close button is offered for the current month." },
    },
  },
};

export const Unbalanced: Story = {
  parameters: {
    mockApi: {
      get: {
        [`/api/close-preview?month=${CUR}`]: makeClosePreview({ month: CUR, closed: false }),
      },
    } satisfies MockApiConfig,
    docs: {
      description: { story: "Money still to assign: the card shows what remains instead of the close button." },
    },
  },
};

export const PastMonthReadOnly: Story = {
  args: { month: PAST },
  parameters: {
    mockApi: {
      get: {
        [`/api/close-preview?month=${PAST}`]: makeClosePreview({ month: PAST, closed: true }),
      },
    } satisfies MockApiConfig,
    docs: {
      description: { story: "A closed past month: the numbers are shown with a Closed badge and no actions." },
    },
  },
};

export const PastMonthOpen: Story = {
  args: { month: PAST },
  parameters: {
    mockApi: {
      get: {
        [`/api/close-preview?month=${PAST}`]: makeClosePreview({ month: PAST, closed: false }),
      },
    } satisfies MockApiConfig,
    docs: {
      description: { story: "A past month that was never closed: still read-only, no close action." },
    },
  },
};
