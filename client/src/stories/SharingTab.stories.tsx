import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { SharingTab } from "../App";
import { fixtureAccounts, makeContactBalance } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof SharingTab> = {
  title: "Sharing/SharingTab",
  component: SharingTab,
  parameters: {
    docs: {
      description: {
        component:
          "The Sharing tab: manage the people you share expenses with, see what each one owes across shared pots, and record their payments. Contact names are user data, rendered as data.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SharingTab>;

const accounts = { accounts: fixtureAccounts };
const alex = () => makeContactBalance({ id: 1, name: "Alex" });
const samSettled = () => makeContactBalance({ id: 2, name: "Sam", totalOwedCents: 0, creditCents: 0, byPot: [], oldest: null });

export const MultipleContacts: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts": { contacts: [alex(), samSettled()] },
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Two contacts: Alex owes across shared pots, Sam is settled up." } },
  },
};

export const SingleContactWithCredit: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts": { contacts: [alex()] },
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "One contact with existing credit from an overpaid settlement." } },
  },
};

export const NoContacts: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts": { contacts: [] },
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "No contacts yet: the manager invites adding the first one." } },
  },
};

export const Loading: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts": () => new Promise(() => {}),
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Skeletons while contacts load." } },
  },
};

export const Error: Story = {
  parameters: {
    mockApi: {
      failGet: ["/api/contacts"],
      get: { "/api/accounts": accounts },
    } satisfies MockApiConfig,
    docs: { description: { story: "The shared error card with retry." } },
  },
};

export const AddContact: Story = {
  parameters: {
    mockApi: (() => {
      const contacts = [alex()];
      return {
        get: {
          "/api/contacts": () => ({ contacts }),
          "/api/accounts": accounts,
        },
        post: {
          "/api/contacts": (body: unknown) => {
            const name = (body as { name: string }).name;
            contacts.push({ ...samSettled(), id: 3, name });
            return { ok: true, id: 3 };
          },
        },
      } satisfies MockApiConfig;
    })(),
    docs: { description: { story: "Adding a contact through the manager. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText("New contact name"), "Jordan");
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));
    await canvas.findByRole("button", { name: "Jordan" });
  },
};

export const RenameContact: Story = {
  parameters: {
    mockApi: (() => {
      const contacts = [alex()];
      return {
        get: {
          "/api/contacts": () => ({ contacts }),
          "/api/accounts": accounts,
        },
        put: {
          "/api/contacts/1": (body: unknown) => {
            contacts[0] = { ...contacts[0], name: (body as { name: string }).name };
            return { ok: true };
          },
        },
      } satisfies MockApiConfig;
    })(),
    docs: { description: { story: "Renaming inline: click the name, edit, Enter. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Alex" }));
    const input = await canvas.findByLabelText("Contact name");
    await userEvent.clear(input);
    await userEvent.type(input, "Alex R.{Enter}");
    await canvas.findByRole("button", { name: "Alex R." });
  },
};

export const DeleteBlocked: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts": { contacts: [alex()] },
        "/api/accounts": accounts,
      },
      delete: {
        "/api/contacts/1": () => {
          throw new Error("Alex is still used by 2 pots and 5 transaction splits. Remove those references first.");
        },
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Deleting a referenced contact is blocked with an explanation. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = (await canvas.findByText("Contacts")).closest("div")!;
    await userEvent.click(within(card).getByRole("button", { name: "Delete" }));
    await userEvent.click(within(card).getByRole("button", { name: "Yes" }));
    await within(card).findByText(/still used by 2 pots/);
  },
};

export const SettleFlow: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts": { contacts: [alex()] },
        "/api/accounts": accounts,
      },
      post: {
        "/api/settle": {
          allocations: [
            { potName: "Rent share", amountCents: 35210 },
            { potName: "Groceries", amountCents: 6970 },
          ],
          leftoverCents: 0,
        },
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Recording a contact's payment fills their buckets. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByLabelText("Payment amount received");
    await userEvent.type(input, "421.80");
    await userEvent.click(canvas.getByRole("button", { name: "Settle up" }));
    await canvas.findByText("Buckets filled");
  },
};
