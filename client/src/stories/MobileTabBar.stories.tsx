import type { Meta, StoryObj } from "@storybook/react-vite";
import { MobileTabBar } from "../App";

/* Six-tab mobile bottom bar: icon-only, every tab directly reachable. */

const meta: Meta<typeof MobileTabBar> = {
  title: "App/MobileTabBar",
  component: MobileTabBar,
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "mobile1" },
    docs: {
      description: {
        component:
          "The mobile bottom tab bar. All six tabs sit directly in the bar in the same order as the desktop sidebar, so there is no More sheet. The active dot is absolutely positioned above the icon, keeping the 24px icon optically centered in its 64px touch target. Dark ink when active, muted grey when inactive. The Pots tab earns a warning dot near month-end when money is still unassigned.",
      },
    },
  },
  args: { onGo: () => {}, closeAlert: false },
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

export const SettingsActive: Story = {
  args: { tab: "settings" },
  parameters: {
    docs: { description: { story: "A trailing tab active: the bar fits all six without scrolling." } },
  },
};

export const SharingActive: Story = {
  args: { tab: "sharing" },
  parameters: {
    docs: { description: { story: "Sharing has its own two-person icon now that it lives in the bar." } },
  },
};

export const AccountsActive: Story = {
  args: { tab: "accounts" },
  parameters: {
    docs: { description: { story: "Accounts has its own card icon now that it lives in the bar." } },
  },
};
