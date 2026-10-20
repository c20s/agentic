# Go best practices

Use this when the diff touches `.go` files.

## Contents

- Error handling
- Concurrency
- Idioms and naming
- Interfaces and composition
- Common footguns

## Error handling

- `if err != nil { return err }` right after every fallible call is idiomatic Go, not boilerplate to eliminate — don't suggest "DRYing it up" into a helper that hides where an error came from.
- Wrap errors with context (`fmt.Errorf("doing X: %w", err)`) rather than returning the raw error or a brand-new unrelated message — the `%w` verb (not `%v`) is what makes `errors.Is`/`errors.As` still work up the call stack; flag `%v` where the caller might want to unwrap.
- Sentinel errors (`var ErrNotFound = errors.New(...)`) plus `errors.Is`, or custom error types plus `errors.As`, are the idiomatic way to let callers branch on error kind — flag string-matching on `err.Error()`.
- Panics are for truly unrecoverable programmer errors (or acceptable at `main`/top-level init) — flag `panic` used for ordinary, expected failure conditions a caller should be able to handle.

## Concurrency

- Every goroutine that can fail or needs to report back should have a clear owner for its errors — a bare `go func() { ... }()` with no error channel, `errgroup`, or `WaitGroup` is worth a question about who observes failures.
- `sync.WaitGroup` for "wait for N independent goroutines", `errgroup.Group` (from `golang.org/x/sync/errgroup`) when any of them can fail and you want the first error plus cancellation — flag hand-rolled wait/cancel logic reinventing either.
- Shared mutable state across goroutines needs a `sync.Mutex`/`sync.RWMutex`/channel, not "it probably won't race" — ask whether `go test -race` covers the code path if mutation across goroutines is visible in the diff.
- Context (`context.Context`) should be the first parameter of functions doing I/O or that should be cancellable, and should be threaded through, not silently dropped or replaced with `context.Background()` partway down the call stack.

## Idioms and naming

- Short, scoped variable names (`i`, `v`, `err`, `ctx`) are idiomatic for short-lived locals in Go — don't apply the "thorough about naming" rule as if this were Java; do still apply it to exported identifiers and anything whose meaning isn't obvious from a few lines of context.
- Exported identifiers need a doc comment starting with the identifier's own name (`// Foo does ...`) — `go vet`/`golint`/`staticcheck` enforce this; flag an exported function/type with no doc comment or one that doesn't start with its name.
- Receiver names should be short and consistent across all methods of the same type (not `this`/`self`) — flag inconsistent receiver names across a type's methods.
- Package names are short, lowercase, no underscores, and not a repeat of what's already implied by the import path (avoid `package util`/`common` — ask what the package is actually for).

## Interfaces and composition

- "Accept interfaces, return structs" — flag a function that takes a concrete struct where only a couple of its methods are used (narrows reusability/testability), and flag a function returning an interface type where a concrete type would do.
- Small, single-method interfaces (`io.Reader`-style) defined at the point of use (by the consumer, not the producer) are the idiomatic Go shape for dependency injection — this is Go's version of the base persona's "ports and adapters" preference; point at it by name when you see a large, provider-defined interface where consumers only use one or two methods.
- Embedding (struct or interface embedding) is Go's composition mechanism instead of classical inheritance — fine and idiomatic; flag it only when it's used to fake inheritance in a way that leaks the embedded type's identity unexpectedly (e.g. through unintended method promotion).

## Common footguns

- Loop variable capture: in Go versions before 1.22, `for _, v := range xs { go func() { use(v) } () }` captures the same `v` across iterations — flag this pattern unless the diff/go.mod confirms Go 1.22+ (where this was fixed).
- Nil map writes panic, nil slice reads/appends don't — check that a map used in the diff is always initialized (`make(map[...]...)` or a literal) before any write.
- Returning a pointer to a loop variable or a local inside a loop needs care under the pre-1.22 semantics above — same root cause as loop variable capture.
- Ignoring an error with `_` (`v, _ := f()`) should stand out and be questioned, just like `any`/`as` elsewhere — it's a silent "trust me" about a fallible call.
- Defer in a loop (`for { defer f() }`) accumulates all deferred calls until the enclosing function returns, not each loop iteration — flag `defer` inside a loop body.
