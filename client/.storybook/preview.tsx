import type { Preview } from "@storybook/react-vite";
import React from "react";
import "../src/index.css";
import { MockApi } from "../src/stories/mockApi";

/* The app drives dark mode from prefers-color-scheme, which stories cannot
   flip per-story. This scoped copy of the dark :root block lets the Theme
   toolbar toggle dark mode inside the story canvas without touching the app. */
const DARK_OVERRIDES = `
.sb-dark-scope {
  --bg: #141412;
  --bg-sunken: #1a1a17;
  --surface: #1e1e1b;
  --ink: #f4f4f0;
  --ink-2: #d8d8d2;
  --muted: #9b9b94;
  --faint: #6a6a63;
  --hairline: rgba(244, 244, 240, 0.1);
  --hairline-strong: rgba(244, 244, 240, 0.18);
  --accent: #55b37e;
  --accent-soft: rgba(85, 179, 126, 0.16);
  --on-accent: #0f120f;
  --success: #3fba6f;
  --warning: #c08a3e;
  --warning-soft: rgba(192, 138, 62, 0.14);
  --danger: #d4695f;
  --danger-soft: rgba(212, 105, 95, 0.14);
  --shadow-card: none;
  --shadow-elev: 0 12px 32px rgba(0, 0, 0, 0.4);
  --chart-1: #55b37e;
  --chart-2: #ecece6;
  --chart-3: #a9a9a0;
  --chart-4: #76766e;
  --chart-5: #4c4c46;
  --chart-6: #7e9bb0;
  --chart-7: #3b3b37;
  --chart-8: #55554f;
  --bar: #edede8;
  background: #141412;
  color: #f4f4f0;
  color-scheme: dark;
}
`;

function ThemeScope({ theme, children }: { theme: string; children: React.ReactNode }) {
  if (theme !== "dark") return <>{children}</>;
  return (
    <>
      <style>{DARK_OVERRIDES}</style>
      <div className="sb-dark-scope" style={{ minHeight: "100vh", padding: "1px 0" }}>
        {children}
      </div>
    </>
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
