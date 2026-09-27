import type { Meta, StoryObj } from "@storybook/react-vite";
import { Donut } from "../App";
import { fixtureDonutSegments } from "./fixtures";

const meta: Meta<typeof Donut> = {
  title: "Insights/Donut",
  component: Donut,
};

export default meta;
type Story = StoryObj<typeof Donut>;

export const Typical: Story = {
  args: { segments: fixtureDonutSegments },
};

export const SingleSegment: Story = {
  args: { segments: [{ label: "Joint Living", cents: 194768 }] },
};

export const ManySegments: Story = {
  args: {
    segments: [
      { label: "Joint Living", cents: 194768 },
      { label: "Food", cents: 83563 },
      { label: "Transport", cents: 48210 },
      { label: "Fun", cents: 32100 },
      { label: "Health", cents: 18450 },
      { label: "Pets", cents: 12300 },
      { label: "Gifts", cents: 8900 },
      { label: "Other", cents: 4100 },
    ],
  },
  parameters: {
    docs: {
      description: { story: "The categorical ramp wraps past eight segments." },
    },
  },
};

export const Empty: Story = {
  args: { segments: [] },
};

export const ZeroTotal: Story = {
  args: { segments: [{ label: "Joint Living", cents: 0 }] },
};
