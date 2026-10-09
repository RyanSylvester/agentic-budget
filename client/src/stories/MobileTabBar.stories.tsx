import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { MobileTabBar } from "../AppShell";

/* Labelled mobile bottom bar: Overview, Pots, Transactions, and More. */

const meta: Meta<typeof MobileTabBar> = {
  title: "App/MobileTabBar",
  component: MobileTabBar,
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "mobile1" },
    docs: {
      description: {
        component:
          "The mobile bottom tab bar. The three month tabs (Overview, Pots, Transactions) sit directly in the bar, each an icon over a short label. Sharing, Accounts and Settings live behind More, which opens a sheet in the same order as the desktop sidebar and reads as active while one of them is open. Each button is a 64px-tall target, the bar pads itself above the home indicator, and the active tab carries aria-current. The Pots tab earns a warning dot near month-end when money is still unassigned.",
      },
    },
  },
  args: { onGo: fn(), closeAlert: false },
};

export default meta;
type Story = StoryObj<typeof MobileTabBar>;

export const OverviewActive: Story = {
  args: { tab: "overview" },
  parameters: {
    docs: { description: { story: "Default state: Overview is the active tab." } },
  },
};

export const PotsActiveWithCloseAlert: Story = {
  args: { tab: "pots", closeAlert: true },
  parameters: {
    docs: {
      description: {
        story: "Pots active with the month-end close alert dot: money is still unassigned and the close card lives on the Pots tab.",
      },
    },
  },
};

export const TransactionsActive: Story = {
  args: { tab: "transactions" },
  parameters: {
    docs: { description: { story: "Transactions active: the longest label still fits a quarter of a 320px screen." } },
  },
};

export const SharingActive: Story = {
  args: { tab: "sharing" },
  parameters: {
    docs: { description: { story: "A tab behind More is open, so More reads as the active tab." } },
  },
};

export const MoreSheetOpen: Story = {
  args: { tab: "accounts", initialMoreOpen: true },
  parameters: {
    docs: {
      description: {
        story: "The More sheet: Sharing, Accounts and Settings, with the open one highlighted. Escape or a backdrop tap closes it.",
      },
    },
  },
};

export const OpenMoreAndPick: Story = {
  args: { tab: "overview" },
  parameters: {
    docs: {
      description: { story: "Tapping More opens the sheet; picking Settings closes it and navigates. (Interaction test.)" },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const more = canvas.getByRole("button", { name: /^More/ });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    const sheet = within(await canvas.findByRole("dialog", { name: "More" }));
    await userEvent.click(sheet.getByRole("button", { name: "Settings" }));
    await expect(args.onGo).toHaveBeenCalledWith("settings");
    await expect(canvas.queryByRole("dialog")).toBeNull();
  },
};
