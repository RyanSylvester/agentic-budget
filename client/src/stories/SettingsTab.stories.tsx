import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { SettingsTab } from "../SettingsTab";
import type { MockApiConfig } from "./mockApi";

/* Settings: the signed-in account and per-user agent token management.
   Tokens are full-access API credentials; the raw value is shown exactly
   once at creation and never stored server-side. All fixture values here
   are invented. */

const me = { authenticated: true, setupRequired: false, username: "owner" };

const twoTokens = {
  tokens: [
    { id: 1, name: "Home server", created_at: "2026-11-02T14:10:00.000Z" },
    { id: 2, name: "Laptop CLI", created_at: "2026-10-18T09:32:00.000Z" },
  ],
};

const meta: Meta<typeof SettingsTab> = {
  title: "Auth/Settings",
  component: SettingsTab,
  parameters: {
    docs: {
      description: {
        component:
          "Account info with log out, plus agent token management: list, create (one-time reveal), and revoke with confirmation.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SettingsTab>;

const baseGet = {
  "/api/auth/me": me,
};

export const TokenList: Story = {
  parameters: {
    mockApi: {
      get: { ...baseGet, "/api/auth/agent-tokens": twoTokens },
    } satisfies MockApiConfig,
    docs: { description: { story: "Two active tokens with names and creation dates. Revoking is a two-step confirm." } },
  },
};

export const EmptyState: Story = {
  parameters: {
    mockApi: {
      get: { ...baseGet, "/api/auth/agent-tokens": { tokens: [] } },
    } satisfies MockApiConfig,
    docs: { description: { story: "No tokens yet. The empty state points at creating the first one." } },
  },
};

export const LoadingState: Story = {
  parameters: {
    mockApi: {
      get: {
        "/api/auth/me": me,
        "/api/auth/agent-tokens": () => new Promise(() => {}),
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Skeleton placeholders while the token list loads." } },
  },
};

export const ErrorState: Story = {
  parameters: {
    mockApi: {
      get: { "/api/auth/me": me },
      failGet: ["/api/auth/agent-tokens"],
    } satisfies MockApiConfig,
    docs: { description: { story: "A failed fetch surfaces a retryable error, not a hang." } },
  },
};

export const CreateFlow: Story = {
  parameters: {
    mockApi: {
      get: { ...baseGet, "/api/auth/agent-tokens": { tokens: [] } },
      post: {
        "/api/auth/agent-tokens": { ok: true, id: 3, token: "cf".repeat(32) },
      },
    } satisfies MockApiConfig,
    docs: {
      description: {
        story: "Creating a token reveals the raw value exactly once, with a copy button and a clear warning.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText("New token name"), "Test runner");
    await userEvent.click(canvas.getByRole("button", { name: "Create token" }));
    await expect(await canvas.findByText(/only time it will be shown/)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  },
};

export const RevokeFlow: Story = {
  parameters: {
    docs: {
      description: {
        story: "Revoke asks for confirmation inline; confirming deletes the token and refreshes the list.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const revokeButtons = await canvas.findAllByRole("button", { name: "Revoke…" });
    await userEvent.click(revokeButtons[0]);
    await userEvent.click(await canvas.findByRole("button", { name: "Revoke" }));
    // The revoked token disappears from the list; the other one stays.
    await waitFor(() => expect(canvas.queryByText("Home server")).not.toBeInTheDocument());
    await expect(canvas.getByText("Laptop CLI")).toBeInTheDocument();
  },
};

/* RevokeFlow needs a stateful mock: the list refetches after DELETE, so the
   mock tracks the remaining tokens across calls. */
RevokeFlow.parameters = {
  ...RevokeFlow.parameters,
  mockApi: (() => {
    let remaining = [...twoTokens.tokens];
    return {
      get: {
        ...baseGet,
        "/api/auth/agent-tokens": () => ({ tokens: remaining }),
      },
      delete: {
        "/api/auth/agent-tokens/1": () => {
          remaining = remaining.filter((t) => t.id !== 1);
          return { ok: true };
        },
      },
    } satisfies MockApiConfig;
  })(),
};
