import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { CloseSummaryCard } from "../PotsTab";
import { fixtureCloseLines, makeClosePreview, MONTH, PAST_MONTH, TODAY_MID, TODAY_MONTH_END } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

/* The month close banner on the Pots tab. */

const balanced = (month: string, over = {}) =>
  makeClosePreview({
    month,
    nextMonth: month === PAST_MONTH ? MONTH : "2026-10",
    inflowsCents: 512000,
    spentCents: 438120,
    rtaBeforeCents: 0,
    movedToSavingsCents: 0,
    pots: fixtureCloseLines,
    closed: false,
    ...over,
  });

const meta: Meta<typeof CloseSummaryCard> = {
  title: "Close/CloseSummaryCard",
  component: CloseSummaryCard,
  args: { month: PAST_MONTH, today: TODAY_MID, onClosed: fn(), onGoMonth: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "A compact banner, shown only when the close is relevant: a past month left open, the last three days of the running month (Close early), or right after closing. One line carries Income, Spend and Unspent. The close is offered once Ready to assign is $0, and the confirm step lists what moves to savings and next month's fill amounts.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof CloseSummaryCard>;

export const PastMonthOpen: Story = {
  parameters: {
    mockApi: { get: { [`/api/close-preview?month=${PAST_MONTH}`]: balanced(PAST_MONTH) } } satisfies MockApiConfig,
    docs: { description: { story: "A past month left open and balanced: the close is one tap away." } },
  },
};

export const PastMonthUnbalanced: Story = {
  parameters: {
    mockApi: {
      get: { [`/api/close-preview?month=${PAST_MONTH}`]: balanced(PAST_MONTH, { rtaBeforeCents: 8633, movedToSavingsCents: 8633 }) },
    } satisfies MockApiConfig,
    docs: { description: { story: "Money still to assign: the banner says what unlocks the close instead of offering it." } },
  },
};

export const PastMonthClosed: Story = {
  parameters: {
    mockApi: { get: { [`/api/close-preview?month=${PAST_MONTH}`]: balanced(PAST_MONTH, { closed: true }) } } satisfies MockApiConfig,
    docs: { description: { story: "Already closed: nothing to do, so the banner renders nothing (the page header shows a Closed badge)." } },
  },
};

export const CloseEarly: Story = {
  args: { month: MONTH, today: TODAY_MONTH_END },
  parameters: {
    mockApi: { get: { [`/api/close-preview?month=${MONTH}`]: balanced(MONTH) } } satisfies MockApiConfig,
    docs: { description: { story: "The last days of the running month: Close early, with a one-line warning about late transactions." } },
  },
};

export const MidMonth: Story = {
  args: { month: MONTH, today: TODAY_MID },
  parameters: {
    docs: { description: { story: "Mid-month the close is not relevant yet: nothing renders and nothing is fetched." } },
  },
};

export const Confirm: Story = {
  parameters: {
    mockApi: {
      get: {
        [`/api/close-preview?month=${PAST_MONTH}`]: balanced(PAST_MONTH, {
          movedToSavingsCents: 0,
          sharedOwedBy: [{ name: "Alex", cents: 42180 }],
        }),
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "The confirm step. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Close August" }));
    await canvas.findByText(/starts with these fill amounts/);
  },
};

export const Closed: Story = {
  parameters: {
    mockApi: {
      get: { [`/api/close-preview?month=${PAST_MONTH}`]: balanced(PAST_MONTH) },
      post: { "/api/close": { ok: true, month: PAST_MONTH } },
    } satisfies MockApiConfig,
    docs: { description: { story: "Just closed: a short confirmation with a link to next month. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Close August" }));
    const buttons = await canvas.findAllByRole("button", { name: "Close August" });
    await userEvent.click(buttons[buttons.length - 1]);
    await canvas.findByText(/is closed/);
  },
};

export const CloseFails: Story = {
  parameters: {
    mockApi: {
      get: { [`/api/close-preview?month=${PAST_MONTH}`]: balanced(PAST_MONTH) },
      failPost: ["/api/close"],
    } satisfies MockApiConfig,
    docs: { description: { story: "The server refuses the close: the error shows under the confirm step. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Close August" }));
    const buttons = await canvas.findAllByRole("button", { name: "Close August" });
    await userEvent.click(buttons[buttons.length - 1]);
    await canvas.findByText(/Couldn't close the month/);
  },
};
