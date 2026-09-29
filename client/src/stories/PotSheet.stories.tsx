import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { PotSheet } from "../App";
import { fixtureContacts, fixturePots, makePot } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof PotSheet> = {
  title: "Pots/PotSheet",
  component: PotSheet,
  parameters: {
    docs: {
      description: {
        component:
          "Add or edit a pot: name, group, the rule that fills it next month, and which contact it is shared with (and their percentage). New pots default to the last-used group and the 3-month-average fill rule. Deleting moves the pot's history to Uncategorized instead of destroying it.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PotSheet>;

const groups = [...new Set(fixturePots.map((p) => p.group))].sort();
const contactsApi = {
  get: { "/api/contacts": { contacts: fixtureContacts } },
} satisfies MockApiConfig;

const sharedPot = fixturePots.find((p) => p.name === "Rent share")!;
const unsharedPot = fixturePots.find((p) => p.name === "Utilities")!;

export const EditShared: Story = {
  args: { pot: sharedPot, groups, onClose: () => {}, onSaved: () => {} },
  parameters: {
    mockApi: contactsApi,
    docs: { description: { story: "Editing a shared pot: name, group, fill rule, and the contact share config." } },
  },
};

export const EditUnshared: Story = {
  args: { pot: unsharedPot, groups, onClose: () => {}, onSaved: () => {} },
  parameters: {
    mockApi: contactsApi,
    docs: { description: { story: "Editing a pot with no share config: the share section starts off." } },
  },
};

export const AddNew: Story = {
  args: { pot: null, groups, onClose: () => {}, onSaved: () => {} },
  parameters: {
    mockApi: contactsApi,
    docs: { description: { story: "Adding a pot from scratch; the share checkbox is off by default." } },
  },
};

export const FillRuleLeftovers: Story = {
  args: { pot: null, groups, onClose: () => {}, onSaved: () => {} },
  parameters: {
    mockApi: contactsApi,
    docs: {
      description: {
        story: "The old fixed-dollar target is gone. The sheet now asks how next month's fill should be computed: last month's assignment, the 3-month average, or leftovers only (skipped by the bulk fill). (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Leftovers" }));
    await canvas.findByText("Skipped by the bulk fill; only month-end leftovers land here.");
  },
};

export const DeleteConfirm: Story = {
  args: { pot: sharedPot, groups, onClose: () => {}, onSaved: () => {} },
  parameters: {
    mockApi: {
      ...contactsApi,
      delete: { [`/api/pots/${sharedPot.id}`]: { ok: true, uncategorizedPotId: 99, movedTransactions: 12, movedAssignments: 3 } },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story: "Deleting asks first and explains that history moves to Uncategorized. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Delete this pot…" }));
    await canvas.findByText(/move to the Uncategorized pot/);
  },
};

export const ShareValidation: Story = {
  args: { pot: makePot({ name: "Dining out", group: "Food" }), groups, onClose: () => {}, onSaved: () => {} },
  parameters: {
    mockApi: contactsApi,
    docs: {
      description: {
        story: "A share percent outside 0-100 is rejected before anything is sent. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText("Share with a contact"));
    const pct = await canvas.findByLabelText("Share percent");
    await userEvent.clear(pct);
    await userEvent.type(pct, "150");
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }));
    await canvas.findByText("Share must be a whole percent from 0 to 100.");
  },
};
