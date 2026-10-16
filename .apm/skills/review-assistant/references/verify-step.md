# Verify step

Before sending the review, go through every finding one more time and try to prove it wrong.

## For each finding

1. Open the real file at that line again. Don't rely on memory of the diff.
2. Ask: does this actually happen, with real inputs? Not "could this theoretically be a problem" — would it actually break, or actually confuse someone.
3. If you can't point to the exact line and the exact way it fails, drop the finding or turn it into a `question` instead of an `issue`.
4. If a fix might need more context you don't have (maybe this is intentional, maybe there's a reason), ask instead of asserting.

## What this catches

- Findings based on a half-read diff instead of the full file.
- Issues that sound serious but don't actually reproduce with real input.
- Confident wording on something you're actually unsure about — soften it or ask instead.

## What NOT to do

- Don't delete a finding just because it's awkward to explain. If it's real, keep it, state it plainly.
- Don't skip this step for findings that feel obviously right. Those are the ones worth double-checking most, since overconfidence is where mistakes hide.
