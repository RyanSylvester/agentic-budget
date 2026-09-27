import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { InsightsTab } from "../App";
import { fixtureHistory, fixturePots, makePot, MONTH } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof InsightsTab> = {
  title: "Tabs/InsightsTab",
  component: InsightsTab,
  args: { month: MONTH },
  parameters: {
    docs: {
      description: {
        component:
          "The full Insights tab: the spending donut plus six-month bars for a chosen pot, with a search picker to switch pots.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof InsightsTab>;

const potsUrl = `/api/pots?month=${MONTH}`;
const topPot = [...fixturePots].sort((a, b) => b.spentCents - a.spentCents)[0];
const coffeePot = fixturePots.find((p) => p.name === "Coffee")!;
const historyUrl = (id: number) => `/api/pot-history?potId=${id}&months=6`;

const loadedApi = {
  get: {
    [potsUrl]: { pots: fixturePots },
    [historyUrl(topPot.id)]: { history: fixtureHistory },
    [historyUrl(coffeePot.id)]: {
      history: [
        { month: "2026-04", spentCents: 3200 },
        { month: "2026-05", spentCents: 4850 },
        { month: "2026-06", spentCents: 4100 },
        { month: "2026-07", spentCents: 5300 },
        { month: "2026-08", spentCents: 4900 },
        { month: "2026-09", spentCents: 4850 },
      ],
    },
  },
} satisfies MockApiConfig;

export const Loaded: Story = {
  parameters: {
    mockApi: loadedApi,
    docs: { description: { story: "Donut and bars loaded for the top-spending pot." } },
  },
};

export const DonutEmpty: Story = {
  parameters: {
    mockApi: {
      get: {
        [potsUrl]: {
          pots: [
            makePot({ name: "Groceries", group: "Food", assignedCents: 60000 }),
            makePot({ name: "Rent share", group: "Joint Living", assignedCents: 172000 }),
          ],
        },
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "No spending this month: the donut shows its empty state while pots still list." } },
  },
};

export const PotsError: Story = {
  parameters: {
    mockApi: { failGet: [potsUrl] } satisfies MockApiConfig,
    docs: { description: { story: "The shared error card when pots fail to load." } },
  },
};

export const HistoryError: Story = {
  parameters: {
    mockApi: {
      get: { [potsUrl]: { pots: fixturePots } },
      failGet: [historyUrl(topPot.id)],
    } satisfies MockApiConfig,
    docs: { description: { story: "The shared error card when a pot's history fails to load." } },
  },
};

export const PickerSearch: Story = {
  parameters: {
    mockApi: loadedApi,
    docs: {
      description: {
        story: "Typing in the pot picker filters the list; picking a pot reloads the bars. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByLabelText("Search pots");
    await userEvent.click(input);
    await userEvent.type(input, "cof");
    const option = await canvas.findByRole("button", { name: /Coffee/ });
    await userEvent.click(option);
    // bars reload for the picked pot
    await canvas.findByText(/3-month avg/);
  },
};
