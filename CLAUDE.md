Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun run check` for Biome (lint + format + organize imports) + tsc type check
- Use `bun run build` instead of `webpack` or `esbuild`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## Testing

Use `bun test` to run tests.
Test files are colocated with their implementation (e.g., `src/pty/index.test.ts` next to `src/pty/index.ts`).

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Code Style

- Do not use `biome-ignore` comments. Fix the code to satisfy the linter instead.
- JSDoc comments describe the **contract** (WHAT/WHEN), not the implementation (HOW).
- Implementation details that need documentation belong in inline code comments.
- Do not re-export. Import directly from the module that defines the symbol.
