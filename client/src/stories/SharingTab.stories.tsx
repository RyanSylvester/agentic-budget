import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { ContactCard, SharingTab } from "../SharingTab";
import { fixtureAccounts, makeContactBalance } from "./fixtures";
import type { ContactLedger, SettlementSummary } from "../types";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof SharingTab> = {
  title: "Sharing/SharingTab",
  component: SharingTab,
  parameters: {
    docs: {
      description: {
        component:
          "The Sharing tab: manage the people you share expenses with (archive instead of delete), see what each one owes and how it adds up, and mark payments in either direction with Undo. Contact names are user data, rendered as data.",
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
        "/api/contacts?archived=1": { contacts: [alex(), samSettled()] },
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
        "/api/contacts?archived=1": { contacts: [alex()] },
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "One contact with existing credit from an overpaid settlement." } },
  },
};

export const SettledViaCredit: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts?archived=1": {
          contacts: [
            makeContactBalance({
              id: 3,
              name: "Jordan",
              totalOwedCents: 25000,
              creditCents: 25000,
              byPot: [
                { pot: "Rent share", cents: 20000 },
                { pot: "Groceries", cents: 5000 },
              ],
              oldest: "2026-08-15",
            }),
          ],
        },
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story:
          "Gross owed fully offset by credit (net $0): the headline reads Settled up at $0.00, with the gross per-pot breakdown and the credit line kept as detail below.",
      },
    },
  },
};

export const OverpaidBeyondOwed: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts?archived=1": {
          contacts: [
            makeContactBalance({
              id: 4,
              name: "Taylor",
              totalOwedCents: 10000,
              creditCents: 15000,
              byPot: [{ pot: "Rent share", cents: 10000 }],
              oldest: "2026-09-10",
            }),
          ],
        },
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story:
          "Credit exceeds gross owed (negative net): the headline reads 'you owe' with the absolute amount instead of a negative 'owes you'.",
      },
    },
  },
};

export const NoContacts: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts?archived=1": { contacts: [] },
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
        "/api/contacts?archived=1": () => new Promise(() => {}),
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Skeletons while contacts load." } },
  },
};

export const LoadError: Story = {
  name: "Error",
  parameters: {
    mockApi: {
      failGet: ["/api/contacts?archived=1"],
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
          "/api/contacts?archived=1": () => ({ contacts }),
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
          "/api/contacts?archived=1": () => ({ contacts }),
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

const alexLedger: ContactLedger = {
  contactId: 1,
  entries: [
    { kind: "settlement", settlementId: 7, transactionId: 40, date: "2026-09-18", description: "Alex settlement", accountName: "Mock Chequing", amountCents: 20000 },
    { kind: "share", transactionId: 39, date: "2026-09-14", description: "Mock grocery run", potName: "Groceries", shareCents: 6970, outstandingCents: 6970 },
    { kind: "share", transactionId: 31, date: "2026-09-01", description: "Mock rent", potName: "Rent share", shareCents: 55210, outstandingCents: 35210 },
    { kind: "share", transactionId: 22, date: "2026-08-27", description: "Mock pharmacy", potName: "Groceries", shareCents: 1450, outstandingCents: 0 },
  ],
};

export const BalanceDetails: Story = {
  parameters: {
    mockApi: { get: { "/api/contacts/1/ledger": alexLedger } } satisfies MockApiConfig,
    docs: {
      description: {
        story:
          "The balance is traceable: expanding a card lists each shared transaction with their share and what is still unpaid, and each settle-up in either direction.",
      },
    },
  },
  render: () => <ContactCard contact={alex()} accounts={fixtureAccounts} initialExpanded />,
};

export const WithArchived: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts?archived=1": {
          contacts: [alex(), makeContactBalance({ id: 5, name: "Riley", totalOwedCents: 0, creditCents: 0, byPot: [], oldest: null, archived: true })],
        },
        "/api/accounts": accounts,
      },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story:
          "Archived contacts are hidden until Show archived is ticked; they keep their history and can be restored. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByLabelText(/Show archived/));
    await canvas.findByRole("button", { name: "Restore Riley" });
  },
};

export const ArchiveBlocked: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts?archived=1": { contacts: [alex()] },
        "/api/accounts": accounts,
      },
      post: {
        "/api/contacts/1/archive": () =>
          new Response(JSON.stringify({ error: "Alex still has an open balance. Settle up before archiving." }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Archiving a contact with an open balance is refused with an explanation. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Archive Alex" }));
    await canvas.findByText(/still has an open balance/);
  },
};

const settled = (over: Partial<SettlementSummary>): SettlementSummary => ({
  settlementId: 9,
  direction: "received",
  amountCents: 42180,
  contactId: 1,
  contactName: "Alex",
  allocations: [],
  creditAllocations: [],
  creditConsumedCents: 0,
  leftoverCents: 0,
  ...over,
});

export const SettleFlow: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts?archived=1": { contacts: [alex()] },
        "/api/accounts": accounts,
      },
      post: {
        "/api/settle": settled({
          allocations: [
            { splitId: 1, potName: "Rent share", amountCents: 35210 },
            { splitId: 2, potName: "Groceries", amountCents: 6970 },
          ],
        }),
        "/api/settlements/9/undo": { ok: true },
      },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story:
          "The amount starts at what they owe, so one tap on Mark $421.80 paid records it into the chosen account; the result offers Undo. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Mark $421.80 paid" }));
    await canvas.findByText("Marked");
    await userEvent.click(canvas.getByRole("button", { name: "Undo" }));
    await canvas.findByText("Payment undone.");
  },
};

export const PayThemBack: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/contacts?archived=1": {
          contacts: [
            makeContactBalance({ id: 4, name: "Taylor", totalOwedCents: 0, creditCents: 5000, byPot: [], oldest: null }),
          ],
        },
        "/api/accounts": accounts,
      },
      post: {
        "/api/settle": settled({ direction: "paid", amountCents: 5000, contactId: 4, contactName: "Taylor", creditConsumedCents: 5000 }),
      },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story:
          "When you owe them (they overpaid), the same flow records money you paid out, from the account you pick. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("You paid Taylor");
    await userEvent.click(await canvas.findByRole("button", { name: "Mark $50.00 paid" }));
    await canvas.findByText(/of their credit paid back/);
  },
};
