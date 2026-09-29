import type { Meta, StoryObj } from "@storybook/react-vite";
import { SinkingLine, PotNameCell } from "../App";
import { makePot } from "./fixtures";

/* All fixture numbers below are invented for illustration; none come from
 * real accounts. */
const meta: Meta<typeof SinkingLine> = {
  title: "Budget Table/Sinking Line",
  component: SinkingLine,
  parameters: {
    docs: {
      description: {
        component:
          "The sinking-schedule readout on a pot row. A slim progress bar tells the savings story at a glance: ink while funding, green once the balance covers the bill, red when the due month has arrived and the bill is still unpaid. The line under it spells out the full picture: saved-of-expected, the monthly pace, months left, and the due month. All numbers are derived live each month, never stored.",
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof SinkingLine>;

const funding = {
  expectedCents: 120000,
  dueMonth: "2027-09",
  cadenceMonths: 12,
  contributionCents: 7500,
  balanceCents: 45000,
  remainingCents: 75000,
  monthsLeft: 10,
  state: "funding" as const,
};

const funded = {
  expectedCents: 120000,
  dueMonth: "2027-09",
  cadenceMonths: 12,
  contributionCents: 0,
  balanceCents: 120000,
  remainingCents: 0,
  monthsLeft: 10,
  state: "funded" as const,
};

const overdue = {
  expectedCents: 90000,
  dueMonth: "2026-09",
  cadenceMonths: 12,
  contributionCents: 50000,
  balanceCents: 40000,
  remainingCents: 50000,
  monthsLeft: 1,
  state: "overdue" as const,
};

export const Funding: Story = {
  args: { sinking: funding },
  parameters: {
    docs: {
      description: {
        story:
          "Mid-schedule: $450.00 saved of $1,200.00, a $75.00/mo pace, 10 months left until the September 2027 bill. The bar fills in ink as the balance grows.",
      },
    },
  },
};

export const Funded: Story = {
  args: { sinking: funded },
  parameters: {
    docs: {
      description: {
        story:
          "Balance covers the bill: the bar is full and green, the line reads the covered amount and the due month, and the monthly contribution pauses at $0 until the bill is paid.",
      },
    },
  },
};

export const Overdue: Story = {
  args: { sinking: overdue },
  parameters: {
    docs: {
      description: {
        story:
          "Due month arrived with the bill unpaid: a red bar stuck at the saved fraction and the $500.00 still needed, so the shortfall is impossible to miss.",
      },
    },
  },
};

export const InPotRow: StoryObj<typeof PotNameCell> = {
  render: () => (
    <PotNameCell
      p={makePot({
        name: "Annual insurance",
        group: "Housing",
        targetCents: 0,
        assignedCents: 45000,
        sinking: funding,
      })}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "How the line sits in the dense pot row: bar and readout under the pot name, replacing the target line so the two never contradict each other.",
      },
    },
  },
};
