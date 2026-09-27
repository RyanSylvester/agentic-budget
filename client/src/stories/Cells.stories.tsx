import type { Meta, StoryObj } from "@storybook/react-vite";
import { Available, SplitTag } from "../App";
import { makePot } from "./fixtures";

const meta: Meta = { title: "Budget Table/Cells" };
export default meta;

export const AvailablePositive: StoryObj<typeof Available> = {
  args: { assignedCents: 60000, spentCents: 55263 },
  render: (args) => <Available {...args} />,
};

export const AvailableZero: StoryObj<typeof Available> = {
  args: { assignedCents: 15000, spentCents: 15000 },
  render: (args) => <Available {...args} />,
};

export const AvailableNegative: StoryObj<typeof Available> = {
  args: { assignedCents: 20000, spentCents: 23450 },
  render: (args) => <Available {...args} />,
};

export const AvailableUnassigned: StoryObj<typeof Available> = {
  args: { assignedCents: 0, spentCents: 3210 },
  render: (args) => <Available {...args} />,
};

export const SplitTagEven: StoryObj = {
  render: () => <SplitTag p={makePot({ spentCents: 171953, partnerCents: 171953 })} />,
};

export const SplitTagPartial: StoryObj = {
  render: () => <SplitTag p={makePot({ spentCents: 55263, partnerCents: 27631 })} />,
};

export const SplitTagNone: StoryObj = {
  render: () => (
    <span className="text-[13px] text-[var(--muted)]">
      renders nothing when the pot has no partner share:
      <SplitTag p={makePot({ spentCents: 9000, partnerCents: 0 })} />
    </span>
  ),
};
