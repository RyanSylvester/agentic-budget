import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CloseCard } from "../App";
import { makeClosePreview } from "./fixtures";

const meta: Meta<typeof CloseCard> = {
  title: "Close/CloseCard",
  component: CloseCard,
  args: { onGo: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The month-end close summary. It shows what happens when the month closes: leftover money moves to savings, and any outstanding shared balance is called out. The close only applies once every dollar is assigned.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof CloseCard>;

export const WithSharedOwed: Story = {
  args: { preview: makeClosePreview({ sharedOwedCents: 42180, sharedOwedBy: [{ name: "Alex", cents: 42180 }] }) },
  parameters: {
    docs: { description: { story: "Close preview with a contact's balance still owed; it links to the Sharing tab." } },
  },
};

export const WithTwoContactsOwed: Story = {
  args: {
    preview: makeClosePreview({
      sharedOwedCents: 62180,
      sharedOwedBy: [
        { name: "Alex", cents: 42180 },
        { name: "Sam", cents: 20000 },
      ],
    }),
  },
  parameters: {
    docs: { description: { story: "Multiple contacts owing: the card shows the total shared balance." } },
  },
};

export const NoSharedOwed: Story = {
  args: { preview: makeClosePreview() },
  parameters: {
    docs: { description: { story: "Close preview with nothing owed by any contact." } },
  },
};

export const ZeroSavings: Story = {
  args: {
    preview: makeClosePreview({
      rtaBeforeCents: -12000,
      movedToSavingsCents: 0,
      assignedCents: 524000,
    }),
  },
  parameters: {
    docs: {
      description: { story: "Negative RTA moves nothing to savings; it stays put." },
    },
  },
};

export const NoAssignedLine: Story = {
  args: {
    preview: { ...makeClosePreview(), assignedCents: undefined },
  },
  parameters: {
    docs: { description: { story: "The assigned line is hidden when the figure is unavailable." } },
  },
};
