import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AssignCell } from "../App";
import { makePot } from "./fixtures";
import type { MockApiConfig } from "./mockApi";

const meta: Meta<typeof AssignCell> = {
  title: "Budget Table/AssignCell",
  component: AssignCell,
  args: {
    pot: makePot({ name: "Groceries", assignedCents: 60000 }),
    month: "2026-09",
    onAssigned: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof AssignCell>;

export const Default: Story = {};

export const CommitSucceeds: Story = {
  parameters: {
    mockApi: {
      post: { "/api/assign": { ok: true } },
    } satisfies MockApiConfig,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Assign to Groceries/ }));
    const input = canvas.getByLabelText("Assign money to Groceries");
    await userEvent.clear(input);
    await userEvent.type(input, "750");
    await userEvent.keyboard("{Enter}");
    await expect(args.onAssigned).toHaveBeenCalled();
    // editor closes after a successful commit
    await expect(canvas.queryByLabelText("Assign money to Groceries")).toBeNull();
  },
};

export const CommitFails: Story = {
  parameters: {
    mockApi: {
      failPost: ["/api/assign"],
    } satisfies MockApiConfig,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Assign to Groceries/ }));
    const input = canvas.getByLabelText("Assign money to Groceries");
    await userEvent.clear(input);
    await userEvent.type(input, "750");
    await userEvent.keyboard("{Enter}");
    await canvas.findByText("Couldn't save.");
  },
};

export const EscapeCancels: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Assign to Groceries/ }));
    const input = canvas.getByLabelText("Assign money to Groceries");
    await userEvent.type(input, "999");
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByLabelText("Assign money to Groceries")).toBeNull();
    await expect(args.onAssigned).not.toHaveBeenCalled();
  },
};
