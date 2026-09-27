import type { Meta, StoryObj } from "@storybook/react-vite";
import { PotBars } from "../App";
import { fixtureHistory } from "./fixtures";

const meta: Meta<typeof PotBars> = {
  title: "Insights/PotBars",
  component: PotBars,
};

export default meta;
type Story = StoryObj<typeof PotBars>;

export const Typical: Story = {
  args: { history: fixtureHistory },
};

export const AllZero: Story = {
  args: {
    history: [
      { month: "2026-04", spentCents: 0 },
      { month: "2026-05", spentCents: 0 },
      { month: "2026-06", spentCents: 0 },
      { month: "2026-07", spentCents: 0 },
      { month: "2026-08", spentCents: 0 },
      { month: "2026-09", spentCents: 0 },
    ],
  },
  parameters: {
    docs: {
      description: { story: "No spend: minimal bars, no average line." },
    },
  },
};

export const SingleMonth: Story = {
  args: { history: [{ month: "2026-09", spentCents: 55263 }] },
};

export const Empty: Story = {
  args: { history: [] },
  parameters: {
    docs: { description: { story: "Renders nothing when there is no history." } },
  },
};

export const Spiky: Story = {
  args: {
    history: [
      { month: "2026-04", spentCents: 1200 },
      { month: "2026-05", spentCents: 98500 },
      { month: "2026-06", spentCents: 3400 },
      { month: "2026-07", spentCents: 2100 },
      { month: "2026-08", spentCents: 1800 },
      { month: "2026-09", spentCents: 2500 },
    ],
  },
  parameters: {
    docs: { description: { story: "One outlier month sets the scale; the average stays readable." } },
  },
};
