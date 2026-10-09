import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { LoginScreen, SignupScreen, type DeriveKey } from "../AuthScreens";
import type { MockApiConfig } from "./mockApi";

/* Login and signup screens. The KDF is stubbed in stories so the
   real argon2id cost does not slow down interaction tests. */

const fastKdf: DeriveKey = async () => "ab".repeat(32);

const challenge = { salt: "cd".repeat(16), kdf_params: "m=19456,t=2,p=1" };

const meta: Meta<typeof LoginScreen> = {
  title: "Auth/Screens",
  component: LoginScreen,
  parameters: {
    docs: {
      description: {
        component:
          "Login and signup. The password never leaves the device: the client derives an Argon2id key and only the derived key is sent to the server.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof LoginScreen>;

async function fillLogin(canvas: ReturnType<typeof within>) {
  await userEvent.type(canvas.getByLabelText("Username"), "owner");
  await userEvent.type(canvas.getByLabelText("Password"), "correct horse");
  await userEvent.click(canvas.getByRole("button", { name: "Log in" }));
}

export const LoginDefault: Story = {
  args: { deriveKey: fastKdf, onAuthenticated: () => {} },
  parameters: {
    mockApi: {
      post: {
        "/api/auth/challenge": challenge,
        "/api/auth/login": { ok: true },
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "The login form at rest." } },
  },
};

export const LoginError: Story = {
  args: { deriveKey: fastKdf, onAuthenticated: () => {} },
  parameters: {
    mockApi: {
      post: {
        "/api/auth/challenge": challenge,
        "/api/auth/login": () =>
          new Response(JSON.stringify({ error: "wrong username or password" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "A wrong password surfaces a plain error, not a hang." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await fillLogin(canvas);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Wrong username or password.");
  },
};

export const LoginRateLimited: Story = {
  args: { deriveKey: fastKdf, onAuthenticated: () => {} },
  parameters: {
    mockApi: {
      post: {
        "/api/auth/challenge": challenge,
        "/api/auth/login": () =>
          new Response(JSON.stringify({ error: "too many attempts" }), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "After 5 attempts per 10 minutes the server answers 429." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await fillLogin(canvas);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(/too many attempts/i);
  },
};

type SignupStory = StoryObj<typeof SignupScreen>;

export const SignupDefault: SignupStory = {
  render: (args) => <SignupScreen {...args} />,
  args: { deriveKey: fastKdf, onSignup: () => {} },
  parameters: {
    mockApi: {
      post: { "/api/auth/signup": { ok: true } },
    } satisfies MockApiConfig,
    docs: { description: { story: "Account creation with an invite code field. The code is optional only for the very first account." } },
  },
};

export const SignupMismatch: SignupStory = {
  render: (args) => <SignupScreen {...args} />,
  args: { deriveKey: fastKdf, onSignup: () => {} },
  parameters: {
    mockApi: { post: { "/api/auth/signup": { ok: true } } } satisfies MockApiConfig,
    docs: { description: { story: "Mismatched confirmation is caught before anything is sent." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Username"), "newuser");
    await userEvent.type(canvas.getByLabelText("Password"), "one");
    await userEvent.type(canvas.getByLabelText("Confirm password"), "two");
    await userEvent.click(canvas.getByRole("button", { name: "Create account" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Passwords don't match.");
  },
};

export const SignupInviteRequired: SignupStory = {
  render: (args) => <SignupScreen {...args} />,
  args: { deriveKey: fastKdf, onSignup: () => {} },
  parameters: {
    mockApi: {
      post: {
        "/api/auth/signup": () =>
          new Response(JSON.stringify({ error: "an invite code is required to sign up" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "Once an account exists, signup without a code is rejected with a plain error." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Username"), "newuser");
    await userEvent.type(canvas.getByLabelText("Password"), "correct horse");
    await userEvent.type(canvas.getByLabelText("Confirm password"), "correct horse");
    await userEvent.click(canvas.getByRole("button", { name: "Create account" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("an invite code is required to sign up");
  },
};

export const SignupBadCode: SignupStory = {
  render: (args) => <SignupScreen {...args} />,
  args: { deriveKey: fastKdf, onSignup: () => {} },
  parameters: {
    mockApi: {
      post: {
        "/api/auth/signup": () =>
          new Response(JSON.stringify({ error: "invalid invite code" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      },
    } satisfies MockApiConfig,
    docs: { description: { story: "A wrong or already-used invite code is rejected." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Username"), "newuser");
    await userEvent.type(canvas.getByLabelText("Password"), "correct horse");
    await userEvent.type(canvas.getByLabelText("Confirm password"), "correct horse");
    await userEvent.type(canvas.getByLabelText("Invite code"), "nope");
    await userEvent.click(canvas.getByRole("button", { name: "Create account" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("invalid invite code");
  },
};
