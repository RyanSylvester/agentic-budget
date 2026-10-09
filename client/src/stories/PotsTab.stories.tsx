import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { PotsTab } from "../PotsTab";
import {
  fixtureCloseLines,
  fixtureContacts,
  fixturePlannedPots,
  fixturePots,
  fixtureTrend,
  FUTURE_MONTH,
  makeClosePreview,
  MONTH,
  PAST_MONTH,
  TODAY_MID,
  TODAY_MONTH_END,
} from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof PotsTab> = {
  title: "Tabs/PotsTab",
  component: PotsTab,
  args: { month: MONTH, today: TODAY_MID, onGoMonth: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The full Pots tab: ready to assign (or what is left to plan) first, the budget table right after it, then top groups and the trend. The month close shows as a compact banner only when it is relevant: a past month left open, the last days of the running month, or just after closing.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PotsTab>;

const url = `/api/pots?month=${MONTH}`;
const trend = { "/api/trend": { trend: fixtureTrend } };
const closePreview = { [`/api/close-preview?month=${MONTH}`]: makeClosePreview() };

export const Loaded: Story = {
  parameters: {
    mockApi: { get: { [url]: { pots: fixturePots, rtaCents: 8633 }, ...trend, ...closePreview } } satisfies MockApiConfig,
    docs: { description: { story: "Mid-month: no close banner, the summary sits straight above the table." } },
  },
};

export const Loading: Story = {
  parameters: {
    mockApi: { get: { [url]: () => new Promise(() => {}) } } satisfies MockApiConfig,
    docs: { description: { story: "Skeleton table while pots load." } },
  },
};

export const Error: Story = {
  parameters: {
    mockApi: { failGet: [url] } satisfies MockApiConfig,
    docs: { description: { story: "The shared error card with retry." } },
  },
};

export const Empty: Story = {
  parameters: {
    mockApi: { get: { [url]: { pots: [], rtaCents: 487250 }, ...trend, ...closePreview } } satisfies MockApiConfig,
    docs: { description: { story: "No pots for the month." } },
  },
};

export const AddPotFlow: Story = {
  parameters: {
    mockApi: {
      get: {
        [url]: { pots: fixturePots, rtaCents: 8633 },
        ...trend,
        ...closePreview,
        "/api/contacts": { contacts: fixtureContacts },
      },
      post: { "/api/pots": { ok: true, id: 999 } },
    } satisfies MockApiConfig,
    docs: { description: { story: "The Add pot button opens the pot editor sheet. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Add pot" }));
    await canvas.findByLabelText("Name");
  },
};

/* ---------- month close ---------- */

const balancedPreview = (month: string, over = {}) =>
  makeClosePreview({
    month,
    nextMonth: month === PAST_MONTH ? MONTH : FUTURE_MONTH,
    inflowsCents: 512000,
    spentCents: 438120,
    assignedCents: 512000,
    rtaBeforeCents: 0,
    movedToSavingsCents: 0,
    pots: fixtureCloseLines,
    closed: false,
    ...over,
  });

const balancedPots = fixturePots.map((p) => (p.name === "Emergency buffer" ? { ...p, assignedCents: 167000 } : p));

const pastApi = (closed: boolean) =>
  ({
    get: {
      [`/api/pots?month=${PAST_MONTH}`]: { pots: balancedPots, rtaCents: 0 },
      ...trend,
      [`/api/close-preview?month=${PAST_MONTH}`]: balancedPreview(PAST_MONTH, { closed }),
    },
    post: { "/api/close": { ok: true, month: PAST_MONTH } },
  }) satisfies MockApiConfig;

export const PastMonthNotClosed: Story = {
  args: { month: PAST_MONTH },
  parameters: {
    mockApi: pastApi(false),
    docs: {
      description: {
        story: "A past month that was never closed: an Open badge and a compact banner offering the close, since Ready to assign is $0.",
      },
    },
  },
};

export const PastMonthClosed: Story = {
  args: { month: PAST_MONTH },
  parameters: {
    mockApi: pastApi(true),
    docs: { description: { story: "A closed past month: just the Closed badge; no banner." } },
  },
};

export const PastMonthNotBalanced: Story = {
  args: { month: PAST_MONTH },
  parameters: {
    mockApi: {
      get: {
        [`/api/pots?month=${PAST_MONTH}`]: { pots: fixturePots, rtaCents: 8633 },
        ...trend,
        [`/api/close-preview?month=${PAST_MONTH}`]: balancedPreview(PAST_MONTH, { rtaBeforeCents: 8633, movedToSavingsCents: 8633 }),
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "A past month left open with money still to assign: the banner says what unlocks the close." } },
  },
};

export const CloseConfirm: Story = {
  args: { month: PAST_MONTH },
  parameters: {
    mockApi: {
      ...pastApi(false),
      get: {
        ...pastApi(false).get,
        [`/api/close-preview?month=${PAST_MONTH}`]: balancedPreview(PAST_MONTH, {
          sharedOwedBy: [{ name: "Alex", cents: 42180 }],
        }),
      },
    },
    docs: {
      description: {
        story: "The confirm step lists what the close does: what moves to savings, what is still owed, and next month's fill amounts. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Close August" }));
    await canvas.findByText(/starts with these fill amounts/);
  },
};

/* Stateful: once the close is posted, the preview reads closed, as the
 * server's would. */
let doneClosed = false;
export const CloseDone: Story = {
  args: { month: PAST_MONTH },
  beforeEach: () => {
    doneClosed = false;
  },
  parameters: {
    mockApi: {
      get: {
        ...pastApi(false).get,
        [`/api/close-preview?month=${PAST_MONTH}`]: () => balancedPreview(PAST_MONTH, { closed: doneClosed }),
      },
      post: {
        "/api/close": () => {
          doneClosed = true;
          return { ok: true, month: PAST_MONTH };
        },
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "After closing: a short confirmation with a link to next month. (Interaction test.)" } },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Close August" }));
    const buttons = await canvas.findAllByRole("button", { name: "Close August" });
    await userEvent.click(buttons[buttons.length - 1]);
    await userEvent.click(await canvas.findByRole("button", { name: /Go to September/ }));
    await expect(args.onGoMonth).toHaveBeenCalledWith(MONTH);
  },
};

export const CurrentMonthLastDays: Story = {
  args: { today: TODAY_MONTH_END },
  parameters: {
    mockApi: {
      get: {
        [url]: { pots: balancedPots, rtaCents: 0 },
        ...trend,
        [`/api/close-preview?month=${MONTH}`]: balancedPreview(MONTH),
      },
      post: { "/api/close": { ok: true, month: MONTH } },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story: "The last days of the running month: Close early is offered, with a warning that late transactions may still arrive.",
      },
    },
  },
};

/* ---------- planning ---------- */

const futureUrl = `/api/pots?month=${FUTURE_MONTH}`;
const futurePots = fixturePlannedPots;
const futureAssigned = futurePots.reduce((a, p) => a + (p.assignable ? p.assignedCents : 0), 0);
const scaffoldPost = {
  "/api/assign/scaffold": {
    ok: true,
    month: FUTURE_MONTH,
    strategy: "average_3mo",
    lines: [
      { potId: futurePots[0].id, name: "Rent share", cents: 172000, income: false },
      { potId: futurePots[3].id, name: "Groceries", cents: 58500, income: false },
      { potId: futurePots[9].id, name: "Paycheck", cents: 512000, income: true },
    ],
  },
};

export const FutureMonth: Story = {
  args: { month: FUTURE_MONTH },
  parameters: {
    mockApi: {
      get: { [futureUrl]: { pots: futurePots, rtaCents: -futureAssigned }, ...trend },
      post: scaffoldPost,
    } satisfies MockApiConfig,
    docs: {
      description: {
        story:
          "A future month with no inflows yet: instead of a red over-assigned figure, a neutral line plans against planned income.",
      },
    },
  },
};

export const FutureMonthEmpty: Story = {
  args: { month: FUTURE_MONTH },
  parameters: {
    mockApi: {
      get: {
        [futureUrl]: { pots: fixturePots.map((p) => ({ ...p, assignedCents: 0, spentCents: 0, sharedCents: 0 })), rtaCents: 0 },
        ...trend,
      },
      post: scaffoldPost,
    } satisfies MockApiConfig,
    docs: { description: { story: "A future month with nothing set: Fill from history is the summary's action." } },
  },
};

export const FillFromHistoryFlow: Story = {
  args: { month: FUTURE_MONTH },
  parameters: {
    mockApi: {
      get: { [futureUrl]: { pots: futurePots, rtaCents: -futureAssigned }, ...trend },
      post: scaffoldPost,
    } satisfies MockApiConfig,
    docs: { description: { story: "Fill from history opens the bulk-fill sheet. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Fill from history" }));
    await canvas.findByText("3-month average");
  },
};

export const CurrentMonthNothingAssigned: Story = {
  parameters: {
    mockApi: {
      get: {
        [url]: {
          pots: fixturePots.map((p) => ({ ...p, assignedCents: 0, spentCents: 0, sharedCents: 0 })),
          rtaCents: 0,
        },
        ...trend,
      },
      post: scaffoldPost,
    } satisfies MockApiConfig,
    docs: { description: { story: "The current month before anything is assigned: Fill from history is the empty-state action." } },
  },
};

export const CurrentMonthPayOnTheWay: Story = {
  parameters: {
    mockApi: {
      get: {
        // $2,000 of the planned $5,120 has landed; $4,800 is assigned.
        [url]: { pots: fixturePlannedPots, rtaCents: 200000 - futureAssigned },
        ...trend,
      },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story: "Received income still below planned income: the summary keeps planning in neutral tones rather than flagging over-assigned.",
      },
    },
  },
};
