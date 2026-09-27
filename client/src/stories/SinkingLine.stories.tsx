import type { Meta, StoryObj } from "@storybook/react-vite";
import { PotNameCell } from "../App";
import { makePot } from "./fixtures";

const meta: Meta = {
  title: "Budget Table/Sinking Line",
  parameters: {
    docs: {
      description: {
        component:
          "The sinking-schedule readout on a pot row. For pots with an annual-bill schedule it replaces the target line: the derived monthly contribution and due month while funding, green 'funded' once the saved balance covers the bill, red when the due month has arrived and the bill is still unpaid. The monthly number is always derived, never stored.",
      },
    },
  },
};
export default meta;

const fundingPot = makePot({
  name: "Property tax",
  group: "Housing",
  targetCents: 0,
  assignedCents: 29901,
  sinking: {
    expectedCents: 348359,
    dueMonth: "2027-07",
    cadenceMonths: 12,
    contributionCents: 29901,
    balanceCents: 89703,
    state: "funding",
  },
});

export const Funding: StoryObj<typeof PotNameCell> = {
  args: { p: fundingPot },
  render: (args) => <PotNameCell {...args} />,
  parameters: {
    docs: {
      description: {
        story:
          "Mid-schedule: $299.01/mo with 9 months left until the July 2027 bill. The number resizes itself every month from the live balance.",
      },
    },
  },
};

export const Funded: StoryObj<typeof PotNameCell> = {
  args: {
    p: makePot({
      name: "Annual insurance",
      group: "Housing",
      targetCents: 0,
      assignedCents: 120000,
      sinking: {
        expectedCents: 118400,
        dueMonth: "2027-03",
        cadenceMonths: 12,
        contributionCents: 0,
        balanceCents: 120000,
        state: "funded",
      },
    }),
  },
  render: (args) => <PotNameCell {...args} />,
  parameters: {
    docs: {
      description: {
        story:
          "Balance covers the bill: the line reads 'funded' in green and the monthly contribution pauses at $0 until the bill is paid.",
      },
    },
  },
};

export const Overdue: StoryObj<typeof PotNameCell> = {
  args: {
    p: makePot({
      name: "Cottage rental deposit",
      group: "Travel",
      targetCents: 0,
      assignedCents: 40000,
      sinking: {
        expectedCents: 90000,
        dueMonth: "2026-09",
        cadenceMonths: 12,
        contributionCents: 50000,
        balanceCents: 40000,
        state: "overdue",
      },
    }),
  },
  render: (args) => <PotNameCell {...args} />,
  parameters: {
    docs: {
      description: {
        story:
          "Due month arrived with the bill unpaid: the full $500 shortfall is due now (one contribution month left), shown in red.",
      },
    },
  },
};

export const ReplacesTargetLine: StoryObj<typeof PotNameCell> = {
  args: { p: fundingPot },
  render: (args) => <PotNameCell {...{ ...args, p: { ...fundingPot, targetCents: 348359 } }} />,
  parameters: {
    docs: {
      description: {
        story:
          "A scheduled pot never shows both lines: even with a target set, only the schedule readout appears. They would contradict each other.",
      },
    },
  },
};
