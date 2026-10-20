# TypeScript / JavaScript best practices

Use this when the diff touches `.ts`, `.tsx`, `.js`, `.jsx`, or `.mjs` files. Covers both language idioms and the Node/Bun/browser ecosystem conventions that come up most often in review.

## Contents

- Typing
- Modern syntax and idioms
- Async and concurrency
- Error handling
- Module and dependency boundaries
- Common footguns

## Typing

- `any` is almost always a smell — prefer `unknown` plus a narrowing check, or a proper type. Flag bare `any`, including implicit `any` from an untyped `.js` dependency.
- Prefer `interface` for object shapes that might be extended or implemented, `type` for unions, intersections, tuples and mapped types. Don't flag mixing them without reason, but flag inconsistency within one file.
- Discriminated unions (`{ kind: "a"; ... } | { kind: "b"; ... }`) are the idiomatic replacement for "one object with a bunch of optional fields that only make sense in combination" — flag the latter shape and point at this pattern by name.
- Prefer `zod`/`io-ts`/similar schema validation at I/O boundaries (parsing JSON, env vars, tool inputs) over manual `if` checks or trusting a type assertion (`as Foo`) — a type assertion is a promise to the compiler, not a runtime check.
- Enums: prefer string union types (`"a" | "b"`) over TypeScript `enum` unless the codebase already has a strong convention otherwise — `enum` has historically had tree-shaking and `const enum` cross-module footguns.
- Non-null assertions (`!`) should stand out — each one is a claim "trust me", and is worth a question if the surrounding code doesn't make it obviously true.

## Modern syntax and idioms

- Optional chaining (`?.`) and nullish coalescing (`??`) over manual `&&`-chains or `|| ` (note `??` vs `||` matters for falsy-but-valid values like `0` or `""` — flag `||` used where `0`/`""` would wrongly be treated as "missing").
- Array/object destructuring over manual indexing (`arr[0]`, `obj["key"]`) when the shape is known.
- `Array.prototype.map/filter/reduce/flatMap/find/some/every` over manual `for` loops for transformations — this mirrors the "no `for`/`while` if sugar exists" rule from the base persona, but as an expert you can name the exact method that fits instead of just disliking the loop.
- Template literals over string concatenation.
- `const`/`let`, never `var`.
- Optional catch binding, logical assignment operators (`??=`, `||=`, `&&=`) are fine and idiomatic in modern (ES2021+) code — don't flag them as "too clever" if the runtime target supports them.
- Top-level `await` in ESM entry points is fine; flag it inside a library module meant to be imported, since it can block consumers' module graph.

## Async and concurrency

- `Promise.all` (or `Promise.allSettled` when partial failure is acceptable) for independent async work — flag sequential `await` in a loop when the iterations don't depend on each other.
- Prefer `async`/`await` over raw `.then()` chains for readability, except when the whole point is fire-and-forget or composing a pipeline of transforms.
- Unhandled promise rejections (a `.then()` without a `.catch()`, or a fire-and-forget `async` call with no error handling) are a real bug class — flag them, don't just suggest style.
- Node/Bun `child_process`/`Bun.spawn` calls run concurrently when `Promise.all`'d — check whether sequential calls to e.g. `git`/`gh` subprocesses could be parallelized when they're independent.

## Error handling

- Prefer throwing `Error` (or a subclass) over throwing strings or plain objects — `instanceof Error` checks and stack traces depend on it.
- "Crash early, catch at the top" from the base persona has a concrete TS/JS shape: validate/assert inputs at the function boundary and let invalid state throw, rather than defensively checking the same thing again three calls deep.
- A function that sometimes returns a value and sometimes returns `undefined`/`null` to signal failure is a weaker contract than one that throws or returns a `Result`-like union — ask which was intended when you see the former in new code.

## Module and dependency boundaries

- Flag circular imports between modules — in both ESM and CJS these cause subtle "works until it doesn't" bugs depending on import order.
- Barrel files (`index.ts` re-exporting everything) can hide the real dependency graph and slow down bundlers/type-checkers — fine in small modules, worth a question in large ones.
- Prefer explicit named exports over default exports in new code (default exports rename silently at the call site and don't tree-shake as predictably) — don't insist on rewriting existing default exports, just don't propagate the pattern.

## Common footguns

- `==` vs `===` — `==`'s coercion rules are a classic source of bugs; `===` should be the default, `==` only for deliberate, commented `null`-or-`undefined` checks.
- Mutating arrays/objects in place (`push`, `splice`, `sort`, direct property assignment on a parameter) when the surrounding code otherwise looks functional — this is the "mutations of arguments" dislike from the base persona, but as an expert you can name the exact non-mutating replacement (`[...arr, x]`, `arr.toSorted()`, `{ ...obj, key: x }`).
- Floating-point arithmetic for money or exact counts — flag `0.1 + 0.2`-style arithmetic on currency; suggest integer cents or a decimal library by name if the domain involves money.
- `JSON.parse(JSON.stringify(x))` as a deep clone drops `undefined`, functions, `Date`, `Map`/`Set` — flag it when the value being cloned isn't a plain JSON-safe object.
- Relying on object key insertion order, or array sort stability, without it being explicit that this is intentional (modern engines do guarantee both, but it's still an easy-to-miss implicit contract).
