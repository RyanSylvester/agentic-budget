import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { TransactionsTab, TransactionSheet } from "../TransactionsTab";
import {
  MONTH,
  fixtureAccounts,
  fixtureContacts,
  fixtureListedTxns,
  fixturePots,
} from "./fixtures";
import type { MockApiConfig } from "./mockApi";

/* The Transactions tab: the full ledger for a month with search, pot and
   type filters, and the add/edit sheet (with void confirmation). */

const firstTxn = fixtureListedTxns[0];

const txnsApi = {
  get: {
    [`/api/transactions?month=${MONTH}`]: { month: MONTH, transactions: fixtureListedTxns },
    [`/api/pots?month=${MONTH}`]: { pots: fixturePots },
    "/api/accounts": { accounts: fixtureAccounts },
    "/api/contacts": { contacts: fixtureContacts },
  },
  post: {
    "/api/transactions": { ok: true, id: 999 },
    [`/api/transactions/${firstTxn.id}/recategorize`]: { ok: true },
    [`/api/transactions/${firstTxn.id}/unvoid`]: { ok: true },
  },
  put: {
    [`/api/transactions/${firstTxn.id}`]: { ok: true },
  },
  delete: {
    [`/api/transactions/${firstTxn.id}`]: { ok: true },
  },
} satisfies MockApiConfig;

const meta: Meta<typeof TransactionsTab> = {
  title: "Tabs/TransactionsTab",
  component: TransactionsTab,
  args: { month: MONTH },
  parameters: {
    mockApi: txnsApi,
    docs: {
      description: {
        component:
          "The Transactions tab: every transaction in the month, newest first, with text search, a pot filter, and an Out/In/Transfers filter. Tapping a row opens the edit sheet; the Add button opens a blank one. Amounts use tabular numerals; inflows read green, transfers read muted.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof TransactionsTab>;

const sheetProps = {
  pots: fixturePots,
  accounts: fixtureAccounts,
  onClose: () => {},
  onSaved: () => {},
};

export const List: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "A typical month: outflows, an inflow, a transfer, two contact splits, and a just-imported expense.",
      },
    },
  },
};

export const Empty: Story = {
  parameters: {
    mockApi: {
      ...txnsApi,
      get: {
        ...txnsApi.get,
        [`/api/transactions?month=${MONTH}`]: { month: MONTH, transactions: [] },
      },
    } satisfies MockApiConfig,
    docs: {
      description: { story: "A month with no transactions yet: an invitation to add the first one." },
    },
  },
};

export const Loading: Story = {
  parameters: {
    mockApi: {
      ...txnsApi,
      get: {
        ...txnsApi.get,
        [`/api/transactions?month=${MONTH}`]: () => new Promise(() => {}),
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Skeleton rows while the ledger loads." } },
  },
};

export const LoadError: Story = {
  parameters: {
    mockApi: {
      ...txnsApi,
      failGet: [`/api/transactions?month=${MONTH}`],
    } satisfies MockApiConfig,
    docs: { description: { story: "The retryable error state when the ledger fails to load." } },
  },
};

export const FilteredBySearch: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Typing in the search box filters by description or pot name, down to the one grocery run. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const box = within(canvasElement).getByPlaceholderText("Search transactions…");
    await userEvent.type(box, "grocery");
    await within(canvasElement).findByText("1 transaction");
  },
};

export const AddSheet: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "The blank add form: description, Out/In amount, date, account, pot, plus transfer and contact-split options. Renders as a bottom sheet on mobile and a centered dialog on desktop.",
      },
    },
  },
  render: () => <TransactionSheet txn={null} {...sheetProps} />,
};

export const EditSheet: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Editing an existing transaction: every field prefilled from the row, with a void option at the bottom.",
      },
    },
  },
  render: () => <TransactionSheet txn={firstTxn} {...sheetProps} />,
};

export const SplitSheet: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "The contact-split section: checking the box reveals a contact picker and their share field, prefilled from the pot's share config (or half the amount).",
      },
    },
  },
  render: () => (
    <TransactionSheet txn={{ ...firstTxn, splitWithContact: 0, sharedCents: 0, splitContactId: null, splitContactName: null }} {...sheetProps} />
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByLabelText("Split with a contact"));
    await within(canvasElement).findByLabelText("Contact to split with");
    await within(canvasElement).findByLabelText("Contact's share");
  },
};

export const SplitSheetEditExisting: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Editing a split transaction: the contact picker and share amount come prefilled from the row.",
      },
    },
  },
  render: () => <TransactionSheet txn={firstTxn} {...sheetProps} />,
};

export const VoidConfirmation: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Voiding asks first: tapping Void transaction swaps the footer for a confirm panel with Keep it and Void. A void removes the row from spending and budgets but keeps it in history, and the tab offers Undo right after. (Interaction test.)",
      },
    },
  },
  render: () => <TransactionSheet txn={firstTxn} {...sheetProps} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Void transaction" }));
    await within(canvasElement).findByText("Void this transaction?");
  },
};

export const ReconciledEdit: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Editing a reconciled transaction: a note explains that amount, account and split are locked, those fields are disabled, and Void is disabled with the reason. The pot, date and description stay editable; a pot change goes through recategorize.",
      },
    },
  },
  render: () => <TransactionSheet txn={{ ...firstTxn, cleared: "reconciled" }} {...sheetProps} />,
};

const nowTx = new Date();
const FUTURE_TX = `${nowTx.getFullYear() + (nowTx.getMonth() === 11 ? 1 : 0)}-${String(
  nowTx.getMonth() === 11 ? 1 : nowTx.getMonth() + 2
).padStart(2, "0")}`;

export const FutureMonth: Story = {
  args: { month: FUTURE_TX },
  parameters: {
    mockApi: {
      get: {
        [`/api/transactions?month=${FUTURE_TX}`]: { month: FUTURE_TX, transactions: [] },
        [`/api/pots?month=${FUTURE_TX}`]: { pots: fixturePots },
        "/api/accounts": { accounts: fixtureAccounts },
        "/api/contacts": { contacts: fixtureContacts },
      },
    } satisfies MockApiConfig,
    docs: {
      description: { story: "A future month with no transactions yet: the empty state, ready for the first entry." },
    },
  },
};
