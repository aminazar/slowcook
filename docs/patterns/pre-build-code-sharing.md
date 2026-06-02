# Pattern: pre-build code sharing (path alias, not workspace package)

> Surfaced from delgoosh dogfood, 2026-06-02 (epic #759). Two new
> Vite-React SPAs needed to share auth + primitives + design-system.
> The instinct was a workspace package. The right answer was a plain
> code directory + path alias.

## When pre-build sharing is the right tool

Two or more apps in the same monorepo share internal infrastructure
(types, hooks, providers, UI primitives) AND:

- All consumers are inside this monorepo
- No consumer publishes to a registry
- No API-boundary enforcement is needed (`export *` from any file is fine)
- Versioning of shared code doesn't need to be independent

In that case, the workspace-package machinery (`packages/foo/package.json`
+ `dependencies: { "@repo/foo": "workspace:*" }` per consumer +
`exports` map + version bumps) is overhead with no benefit.

## When the workspace package IS the right tool

- The shared package will be published to npm
- You need a strict API boundary (only what's in `index.ts` is public)
- The shared package has its own test suite + lifecycle scripts
- Multiple repos consume it

## How

### Shared dir

```
packages/shared-spa/
├── src/
│   ├── lib/{api,auth}.ts
│   ├── components/...
│   └── design-system/...
└── public/  (assets the apps want to host)
```

No `package.json`, no `tsconfig.json` (consumers' tsconfig includes
the source).

### Consumer config

Each consumer app's `vite.config.ts` (or webpack, etc.):

```ts
resolve: {
  alias: {
    '@shared': path.resolve(__dirname, '../../packages/shared-spa/src'),
  },
}
```

Each consumer's `tsconfig.json` paths:

```json
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["../../packages/shared-spa/src/*"]
    }
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "../../packages/shared-spa/src/**/*.ts",
    "../../packages/shared-spa/src/**/*.tsx"
  ]
}
```

Each consumer's Tailwind `content` glob (if applicable):

```ts
content: [
  './src/**/*.{ts,tsx}',
  '../../packages/shared-spa/src/**/*.{ts,tsx}',
]
```

### Consumption looks identical to a workspace package

```ts
import { useAuth } from '@shared/lib/auth';
import { Button } from '@shared/components/ui/button';
```

## Bundle outcome

Same as workspace-package import. The bundler (Vite/webpack) walks the
alias, resolves the source files, includes them in each app's output
chunk. If two apps share `Button`, each app's bundle has its own copy
of `Button` — same as it would with a workspace package.

For runtime sharing across apps (one bundle loaded once, multiple apps
consume), you need **module federation** which is a separate pattern.

## brew prompt addendum

When emitting shared code for two or more consumers in the same
monorepo, brew should default to the pre-build path-alias pattern.
Switch to workspace package only when one of the "right tool"
conditions above applies.
