# Python best practices

Use this when the diff touches `.py` files. Assume modern Python (3.10+) unless the repo's `pyproject.toml`/`setup.cfg`/CI config says otherwise — check that file before assuming a feature is available.

## Contents

- Typing
- Modern syntax and idioms
- Async and concurrency
- Error handling
- Dependency and project structure
- Common footguns

## Typing

- Type hints on public function signatures are expected in modern Python codebases — flag untyped public functions in a codebase that otherwise uses hints, but don't demand hints in a codebase that has none anywhere (that's a bigger, separate conversation).
- Prefer `list[str]`, `dict[str, int]`, `X | None` (3.10+) over `List[str]`, `Dict[str, int]`, `Optional[X]` from `typing` — the latter is legacy once the Python floor supports PEP 585/604.
- `Any` is as much a smell here as `any` in TypeScript — prefer `object` plus narrowing, a `Protocol`, or a real type.
- Prefer `dataclasses` (or `pydantic`/`attrs` if already a dependency) over a hand-rolled `__init__` that just assigns every argument to `self` — ask about it by name if you see the manual version in new code.
- `Protocol` (structural typing) over an abstract base class when the only goal is "anything with this shape/method" — ABCs imply a real inheritance relationship, `Protocol` doesn't.

## Modern syntax and idioms

- Comprehensions (list/dict/set) and generator expressions over manual `for` + `append` loops — same "sugar exists, use it" rule as the base persona, now with the exact idiom named.
- `match` statements (3.10+) are the idiomatic replacement for a long `if/elif` chain dispatching on a value's shape or type — but note the base persona dislikes `switch`-likes in general, so still ask whether the dispatch itself (vs. polymorphism/a dict of functions) is the right shape, even when `match` is used.
- f-strings over `.format()` or `%`-formatting.
- `pathlib.Path` over manual `os.path.join`/string concatenation for filesystem paths.
- Walrus operator (`:=`) is fine for avoiding a repeated computation in a comprehension or `while` condition — flag it only if it's used to cram multiple unrelated steps into one expression.
- Context managers (`with`) for anything with a lifecycle (files, locks, db connections, temp dirs) — flag manual `open()`/`close()` pairs.

## Async and concurrency

- `asyncio.gather` for independent async work, same spirit as `Promise.all` — flag sequential `await` in a loop over independent items.
- Mixing blocking I/O (`requests`, synchronous file/db calls) inside an `async def` function blocks the whole event loop — this is a real bug, not a style nit, flag it plainly.
- `asyncio.run()` should appear once, at the true entry point — flag it appearing deep inside library code, since it can't be nested and fights whatever event loop the caller is already running.

## Error handling

- Catching bare `except:` (or `except Exception:` when a narrower exception is known) swallows things like `KeyboardInterrupt`/`SystemExit` or masks real bugs — ask what specific exception is expected.
- "Crash early, catch at the top" maps directly to Python: validate/raise at the function boundary (`raise ValueError(...)`) instead of returning `None`/a sentinel and hoping every caller checks it.
- Custom exception classes (subclassing `Exception`) are cheap and make `except SpecificError` possible later — worth suggesting when a function raises a generic `Exception` with a message that callers are clearly expected to branch on.

## Dependency and project structure

- Modern dependency/packaging tools (`uv`, `poetry`, `pdm`, or at minimum `pyproject.toml` with `pip-tools`) are the current norm over an unpinned `requirements.txt` with no lockfile — ask if a repo has neither.
- Mutable default arguments (`def f(x=[])`) are a classic, well-known Python footgun (the default is shared across calls) — flag unconditionally, this is not a style opinion, it's a bug waiting to happen.
- Package layout: a `src/` layout (`src/pkgname/...`) avoids accidentally importing the uninstalled local copy during tests — worth a question if absent and the repo is a publishable package, not worth raising for a simple script repo.

## Common footguns

- Mutable default arguments (see above) — worth repeating, it's the single most common Python review finding.
- Late-binding closures in loops (`[lambda: i for i in range(3)]` all return `2`) — flag when a loop creates closures/lambdas capturing the loop variable.
- `is` vs `==` — `is` should only be used for `None`/singleton identity checks, never for value equality.
- Shadowing builtins (`list`, `dict`, `type`, `id`, `input` as variable names) — small but real, worth a naming comment.
- Floating point for money, same as TypeScript — suggest `decimal.Decimal` or integer cents by name.
