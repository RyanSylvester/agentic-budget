import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Eyebrow, FetchError, Skeleton } from "../App";

const meta: Meta = {
  title: "Primitives",
  parameters: { layout: "padded" },
};

export default meta;

export const EyebrowLabel: StoryObj = {
  render: () => <Eyebrow>Needs attention</Eyebrow>,
};

export const Skeletons: StoryObj = {
  render: () => (
    <div className="space-y-2.5">
      <Skeleton className="h-[54px]" />
      <Skeleton className="h-[54px] w-2/3" />
      <Skeleton className="h-5 w-44" />
    </div>
  ),
};

export const FetchErrorDefault: StoryObj = {
  render: () => <FetchError onRetry={fn()} />,
};

export const FetchErrorCustomLabel: StoryObj = {
  render: () => <FetchError onRetry={fn()} label="Couldn't load the partner balance." />,
};
