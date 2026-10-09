import type { Preview } from "@storybook/react-vite";
import React from "react";
import "../src/index.css";
import { MockApi } from "../src/stories/mockApi";

/* The app drives dark mode from prefers-color-scheme, which stories cannot
   flip per-story. index.css also honours a data-theme attribute on any
   wrapper, so the Theme toolbar scopes the same tokens the app uses: no
   copied palette to drift. */
function ThemeScope({ theme, children }: { theme: string; children: React.ReactNode }) {
  return (
    <div
      data-theme={theme === "dark" ? "dark" : "light"}
      style={{ minHeight: "100vh", padding: "1px 0", background: "var(--bg)", color: "var(--ink)" }}
    >
      {children}
    </div>
  );
}

const preview: Preview = {
  tags: ["autodocs"],
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Color scheme",
      defaultValue: "light",
      toolbar: {
        icon: "contrast",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = (context.globals.theme as string) ?? "light";
      return (
        <ThemeScope theme={theme}>
          <MockApi key={context.id} config={context.parameters.mockApi}>
            <Story />
          </MockApi>
        </ThemeScope>
      );
    },
  ],
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    layout: "padded",
  },
};

export default preview;
