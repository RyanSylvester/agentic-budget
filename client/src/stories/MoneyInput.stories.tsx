import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import { MoneyInput } from "../MoneyInput";

const meta: Meta<typeof MoneyInput> = {
  title: "Primitives/MoneyInput",
  component: MoneyInput,
  parameters: {
    docs: {
      description: {
        component:
          "The single money field used everywhere an amount is typed. The dollar sign is a fixed, non-editable label (it can never be deleted or mangled), and typing a math expression like 25+30*2 shows a live '= 85.00' hint. Commit sites evaluate with a small parser, never eval().",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof MoneyInput>;

function Controlled(args: React.ComponentProps<typeof MoneyInput>) {
  const [v, setV] = useState("");
  return <MoneyInput {...args} value={v} onChange={setV} />;
}

export const Default: Story = {
  render: (args) => <Controlled {...args} ariaLabel="Amount" placeholder="0.00" />,
  parameters: {
    docs: { description: { story: "Resting state: the $ is part of the chrome, not the text, so backspacing can never remove it." } },
  },
};

export const MathHint: Story = {
  render: (args) => <Controlled {...args} ariaLabel="Amount" />,
  parameters: {
    docs: {
      description: {
        story: "Typing an expression shows the computed result as a hint above the field. Pressing Enter in a real form commits the computed cents. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText("Amount");
    await userEvent.type(input, "25+30*2");
    await canvas.findByText("= 85.00");
    // The raw expression stays in the field; the form evaluates on commit.
    expect((input as HTMLInputElement).value).toBe("25+30*2");
  },
};

export const InvalidExpression: Story = {
  render: (args) => <Controlled {...args} ariaLabel="Amount" />,
  parameters: {
    docs: { description: { story: "A malformed expression (here, a trailing operator) shows no hint instead of a wrong number. (Interaction test.)" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Amount"), "25+");
    await expect(canvas.queryByText(/= /)).toBeNull();
  },
};
