import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { Eyebrow, FetchError, Sheet, Skeleton } from "../ui";

const meta: Meta = {
  title: "Primitives",
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "The smallest building blocks used across the app: section eyebrows, loading skeletons, and the shared fetch-error card with retry.",
      },
    },
  },
};

export default meta;

export const EyebrowLabel: StoryObj = {
  render: () => <Eyebrow>Needs attention</Eyebrow>,
  parameters: {
    docs: {
      description: {
        story: "Small caps section label. Only a few sections keep one; most pages use serif titles instead.",
      },
    },
  },
};

export const Skeletons: StoryObj = {
  render: () => (
    <div className="space-y-2.5">
      <Skeleton className="h-[54px]" />
      <Skeleton className="h-[54px] w-2/3" />
      <Skeleton className="h-5 w-44" />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Placeholder rows shown while content loads. They hold the layout so the page does not jump when data arrives.",
      },
    },
  },
};

export const FetchErrorDefault: StoryObj = {
  render: () => <FetchError onRetry={fn()} />,
  parameters: {
    docs: {
      description: {
        story: "Shared error card with a retry button, used everywhere a request fails.",
      },
    },
  },
};

export const FetchErrorCustomLabel: StoryObj = {
  render: () => <FetchError onRetry={fn()} label="Couldn't load the shared balance." />,
  parameters: {
    docs: {
      description: {
        story: "The error card accepts a custom message naming what failed to load.",
      },
    },
  },
};

function SheetDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)} className="btn-ink px-4 py-2 text-[15px]">
        Open sheet
      </button>
      {open && (
        <Sheet label="Demo sheet" onClose={() => setOpen(false)}>
          <div className="mb-3 text-[17px] font-semibold">Demo sheet</div>
          <input aria-label="Name" className="field w-full px-3 py-2.5 text-[15px]" />
          <div className="mt-4 flex gap-2">
            <button onClick={() => setOpen(false)} className="btn-ghost flex-1 py-2.5 text-[15px]">Cancel</button>
            <button onClick={() => setOpen(false)} className="btn-ink flex-1 py-2.5 text-[15px]">Save</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

export const SheetKeyboard: StoryObj = {
  render: () => <SheetDemo />,
  parameters: {
    docs: {
      description: {
        story:
          "The shared sheet behaves like a modal: focus moves into it on open, Tab and Shift+Tab cycle inside it, Escape closes it, and focus returns to the button that opened it. (Interaction test.)",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const opener = canvas.getByRole("button", { name: "Open sheet" });
    await userEvent.click(opener);
    const dialog = await canvas.findByRole("dialog", { name: "Demo sheet" });
    await expect(dialog.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 5; i++) await userEvent.tab();
    await expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.tab({ shift: true });
    await expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("dialog")).toBeNull();
    await expect(document.activeElement).toBe(opener);
  },
};
