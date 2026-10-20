# Rust best practices

Use this when the diff touches `.rs` files.

## Contents

- Ownership and borrowing
- Error handling
- Concurrency
- Idioms and traits
- Common footguns

## Ownership and borrowing

- `.clone()` used to silence a borrow-checker complaint, rather than because a real independent copy is needed, is worth a question — ask whether the lifetime/ownership could be restructured instead, without prescribing exactly how.
- Prefer borrowing (`&T`/`&mut T`) over taking ownership in function signatures when the function doesn't need to keep the value — taking `String`/`Vec<T>` by value when `&str`/`&[T]` would do forces needless clones on callers.
- `Rc<RefCell<T>>` (or worse, `Arc<Mutex<T>>` in single-threaded code) appearing to work around the borrow checker is a smell worth naming — it trades a compile-time guarantee for a runtime one (`RefCell` panics on a double-borrow instead of failing to compile).
- Lifetimes made explicit everywhere "just in case" rather than only where elision fails are harder to read for no benefit — flag unnecessary explicit lifetime annotations the compiler would elide anyway.

## Error handling

- `Result<T, E>` plus `?` is the idiom for fallible operations — flag `.unwrap()`/`.expect()` on a `Result`/`Option` in non-test, non-"truly impossible to fail here" code; this is the direct Rust equivalent of the base persona's "crash early, catch at the top", but an uncommented `.unwrap()` crashes with no context at all, which is worse than a thrown `Error` with a message.
- `thiserror` for library error enums, `anyhow` for application-level "just propagate with context" error handling — flag a hand-rolled `impl std::error::Error` when `thiserror` is already a dependency, or a function returning `Box<dyn Error>` deep in a library's public API where a concrete enum would let callers match on it.
- `.expect("message")` over bare `.unwrap()` when a panic is truly intended — the message is the only context a post-mortem gets.

## Concurrency

- `Send`/`Sync` bounds on generic code meant to be used across threads should be explicit and intentional, not accidentally inferred — ask about it when a type meant for concurrent use doesn't obviously carry these bounds.
- Prefer channels (`std::sync::mpsc`, or async channels from the runtime in use) for ownership-transferring communication between tasks/threads over sharing a `Mutex<T>` when the data doesn't need to be read by multiple sides concurrently.
- Async runtime mixing (spawning a `tokio` task from code that assumes a different runtime, or blocking inside an async fn with a synchronous call) is a real bug, same caution as Python's asyncio+blocking-I/O footgun — flag any synchronous, blocking call (`std::thread::sleep`, blocking I/O) inside an `async fn` body.

## Idioms and traits

- Prefer implementing a trait (`From`, `TryFrom`, `Iterator`, `Display`) over a bespoke method name doing the same conceptual job — e.g. a `fn to_foo(&self) -> Foo` doing an infallible conversion should probably be `impl From<X> for Foo` instead, so it composes with `.into()` and generic code.
- Builder pattern (consuming or `&mut self`-returning-`Self` methods) is the idiomatic way to handle many-optional-field construction — flag a constructor function with a long list of `Option<T>` parameters instead.
- `impl Trait` in argument/return position over a generic `<T: Trait>` when the concrete type doesn't need to be named by the caller — purely a readability idiom, not a correctness issue, so phrase as a suggestion not an issue.
- Newtype pattern (`struct UserId(u64)`) over passing primitives around for distinct domain concepts — flag two same-typed primitive parameters next to each other in a signature (e.g. `fn transfer(from: u64, to: u64)`) as an easy mix-up the type system could prevent.

## Common footguns

- Integer overflow panics in debug builds but silently wraps in release builds by default — flag arithmetic on user-controlled or untrusted integers that doesn't use `checked_*`/`saturating_*`/`wrapping_*` explicitly, since the behavior differs between dev and prod.
- `unsafe` blocks need a `// SAFETY:` comment explaining the invariant being upheld — this is the one place the base persona's "no comments except on interfaces" rule should bend; flag an `unsafe` block with no safety comment.
- Shadowing with `let` is idiomatic Rust (unlike most C-family languages) — don't flag simple type-narrowing shadowing (`let x: u32 = x.try_into()?;`) as a naming problem, that's normal here.
- Returning `&'static str` or leaking memory (`Box::leak`) to work around a lifetime issue is a sign the actual ownership model needs rethinking, not that a leak is the fix — worth a question, without prescribing the restructure.
