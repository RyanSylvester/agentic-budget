import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CloseCard } from "../App";
import { makeClosePreview } from "./fixtures";

const meta: Meta<typeof CloseCard> = {
  title: "Close/CloseCard",
  component: CloseCard,
  args: { onGo: fn() },
};

export default meta;
type Story = StoryObj<typeof CloseCard>;

export const WithPartnerOwed: Story = {
  args: { preview: makeClosePreview({ partnerOwedCents: 42180 }) },
};

export const NoPartnerOwed: Story = {
  args: { preview: makeClosePreview() },
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
};
