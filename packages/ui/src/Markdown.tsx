import { Streamdown } from "streamdown";

/**
 * Agent text. Streamdown renders half-written markdown sensibly while it streams and
 * sanitizes the output, so model-written links and HTML cannot inject script.
 */
export default function Markdown({ text, animating }: { text: string; animating: boolean }) {
  return (
    <Streamdown
      isAnimating={animating}
      className="space-y-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold">
      {text}
    </Streamdown>
  );
}
