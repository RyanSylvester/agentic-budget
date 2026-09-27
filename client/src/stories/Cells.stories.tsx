import type { Meta, StoryObj } from "@storybook/react-vite";
import { Available, SplitTag } from "../App";
import { makePot } from "./fixtures";

const meta: Meta = {
  title: "Budget Table/Cells",
  parameters: {
    docs: {
      description: {
        component:
          "The small cells inside the budget table. Available is assigned minus spent: green when positive, red when overspent. SplitTag marks pots shared with a partner.",
      },
    },
  },
};
export default meta;

export const AvailablePositive: StoryObj<typeof Available> = {
  args: { assignedCents: 60000, spentCents: 55263 },
  render: (args) => <Available {...args} />,
  parameters: {
    docs: { description: { story: "Spent less than assigned: green." } },
  },
};

export const AvailableZero: StoryObj<typeof Available> = {
  args: { assignedCents: 15000, spentCents: 15000 },
  render: (args) => <Available {...args} />,
  parameters: {
    docs: { description: { story: "Fully spent: neutral zero." } },
  },
};

export const AvailableNegative: StoryObj<typeof Available> = {
  args: { assignedCents: 20000, spentCents: 23450 },
  render: (args) => <Available {...args} />,
  parameters: {
    docs: { description: { story: "Overspent: red." } },
  },
};

export const AvailableUnassigned: StoryObj<typeof Available> = {
  args: { assignedCents: 0, spentCents: 3210 },
  render: (args) => <Available {...args} />,
  parameters: {
    docs: { description: { story: "Nothing assigned yet with spending recorded: the pot needs funding." } },
  },
};

export const SplitTagEven: StoryObj = {
  render: () => <SplitTag p={makePot({ spentCents: 171953, partnerCents: 171953 })} />,
  parameters: {
    docs: { description: { story: "An evenly split pot shows the 50% tag." } },
  },
};

export const SplitTagPartial: StoryObj = {
  render: () => <SplitTag p={makePot({ spentCents: 55263, partnerCents: 27631 })} />,
  parameters: {
    docs: { description: { story: "A partially shared pot shows the partner's share as an amount." } },
  },
};

export const SplitTagNone: StoryObj = {
  render: () => (
    <span className="text-[13px] text-[var(--muted)]">
      renders nothing when the pot has no partner share:
      <SplitTag p={makePot({ spentCents: 9000, partnerCents: 0 })} />
    </span>
  ),
  parameters: {
    docs: { description: { story: "Pots with no partner share render no tag at all." } },
  },
};
