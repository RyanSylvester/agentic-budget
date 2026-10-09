import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Eyebrow, FetchError, Skeleton } from "../ui";

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
