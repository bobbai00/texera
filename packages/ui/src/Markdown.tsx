import { type ComponentProps, type ReactNode, useMemo } from "react";
import { defaultComponents, Streamdown } from "streamdown";

const Code = defaultComponents.code as (props: ComponentProps<"code">) => ReactNode;

/**
 * Agent text. Streamdown renders half-written markdown sensibly while it streams and
 * sanitizes the output, so model-written links and HTML cannot inject script. `inline`, when
 * given, may draw a piece of inline code as something else.
 */
export default function Markdown({
  text,
  animating,
  inline,
}: {
  text: string;
  animating: boolean;
  inline?: (code: string) => ReactNode | undefined;
}) {
  const components = useMemo(
    () =>
      inline && {
        inlineCode: (props: ComponentProps<"code">) =>
          (typeof props.children === "string" ? inline(props.children) : undefined) ?? <Code {...props} />,
      },
    [inline]
  );
  return (
    <Streamdown
      isAnimating={animating}
      components={components || undefined}
      className="space-y-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold">
      {text}
    </Streamdown>
  );
}
