# Structure and architecture

A change can be correct and still be in the wrong place. Both matter. Don't only check if the code works — check if it's where it should live.

## What to look for

- A function or block that has nothing to do with the rest of the file it's in.
- Logic copied into two places that should be one shared place.
- A new file that duplicates something an existing file already does, instead of extending it.
- A doc, comment, or config change that would make more sense living next to the thing it's actually about.
- A change that grew a file or module past the point where it's still doing one thing.

## How to raise it

Use `suggestion`, not `issue`, unless the current placement actively causes a bug. Point at a specific better place, don't just say "this feels off":

- `suggestion: this validation logic is the same as in src/forms/validate.ts, maybe move it there and share it?`
- `suggestion: this doc reads more like a reference for the reviewing skill than part of the main README, could it move to references/?`

If you're not sure there's a better place, but something still feels misplaced, use `question` instead and ask where it should live — don't force a suggestion you're not confident in.

## When to let it go

Don't raise a structure comment just to have one. If the placement is reasonable, even if it's not how you'd have done it, say nothing. This is about things that are actually in the wrong place, not about matching your personal preference.
