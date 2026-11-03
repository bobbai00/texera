The app has no stylesheet of its own: `src/main.tsx` imports `@texera/ui/styles/tokens.css`,
which holds the tokens, Tailwind and the shared utilities. Kind modules and chat parts compose
primitives and tokens; none defines a color or a size.
