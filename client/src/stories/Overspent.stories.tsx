import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CoverSheet, CoverToast, OverspentLine } from "../Overspent";
import { fixtureOverspentPots, makePot } from "./fixtures";

const dining = fixtureOverspentPots.find((p) => p.name === "Dining out")!;

const meta: Meta<typeof CoverSheet> = {
  title: "Budget Table/CoverSheet",
  component: CoverSheet,
  args: { pot: dining, pots: fixtureOverspentPots, rtaCents: 8633, onClose: fn(), onCover: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "Cover from…: fixing an overspent pot by moving assigned money from Ready to assign or from another pot with money left this month. Each choice moves the smaller of the overspend and what the source has, so no source goes negative.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof CoverSheet>;

export const Sources: Story = {
  parameters: {
    docs: { description: { story: "Ready to assign first, then pots with the most left. Coffee and Rideshare are overspent themselves, so they are not offered." } },
  },
};

export const PartialCover: Story = {
  args: {
    rtaCents: 0,
    pots: [dining, makePot({ name: "Internet", group: "Joint Living", spentCents: 8995, assignedCents: 9000 }), makePot({ name: "Utilities", group: "Joint Living", spentCents: 13820, assignedCents: 14000 })],
  },
  parameters: {
    docs: { description: { story: "Nothing in Ready to assign and only small balances left: each source covers part of the $34.50." } },
  },
};

export const NoSources: Story = {
  args: { rtaCents: 0, pots: [dining] },
  parameters: {
    docs: { description: { story: "No money left anywhere this month: the sheet says what to do instead." } },
  },
};

export const SummaryLine: StoryObj<typeof OverspentLine> = {
  render: () => <OverspentLine count={2} cents={8410} action="Show" onClick={fn()} />,
  parameters: {
    docs: { description: { story: "The overspent summary line used on the Pots summary card." } },
  },
};

export const UndoBar: StoryObj<typeof CoverToast> = {
  render: () => <CoverToast text="Moved $34.50 from Ready to assign to Dining out" onUndo={fn()} onDismiss={fn()} />,
  parameters: {
    docs: { description: { story: "After a cover: what moved, with Undo for a few seconds." } },
  },
};
