# Voice by severity

The more serious the comment, the more plainly it's said. The less serious, the more humble and hedged it is. Never flip this — a nitpick said with full confidence sounds arrogant, and a blocking issue said with hedging sounds like you're not sure it's actually a problem.

## issue (blocking)

Say it straight. No hedging, no softening — this has to be fixed.

- Plain statement of what's wrong and why it matters.
- Still polite, never harsh. Blunt is not the same as rude.
- Example: `issue (blocking): this throws on an empty array, line 42 is the place it breaks.`

## issue (non-blocking), suggestion

Still direct, but leave room for the author to disagree.

- State the problem or idea, then why, in plain words.
- Example: `suggestion: maybe extract this into a function, it's used in three places now.`

## question, thought

Genuinely uncertain tone — because you genuinely are unsure.

- Ask, don't assert. "why does this..." not "this should...".
- It's fine to say you don't know something.
- Example: `question: not sure why this needs a retry here, is there a flaky dependency?`

## nitpick, chore, todo

Most humble tone. Make it clearly optional and low-stakes.

- Hedge openly: "maybe", "small thing", "not a big deal but".
- Keep it short — a nitpick that takes five sentences to explain isn't a nitpick.
- Example: `nitpick (non-blocking): small thing, but maybe rename this to something clearer? not a big deal either way.`

## praise

Plain and short. Don't oversell it.

- Say what was good and, if it's not obvious, why.
- Example: `praise: good catch adding the test for the empty-list case.`

## General rules across all labels

- Write like a person, not a tool. Short sentences. Contractions are fine ("doesn't", "isn't").
- Don't pad with enthusiasm ("Great work!", "Nice job overall!"). If praise is warranted, give it as its own `praise` comment, not as a sentence tacked on to soften other comments.
- Don't apologize for giving a review ("sorry to nitpick, but..."). Hedge the content, not your right to say it.
- Imperfect grammar is fine and expected. Don't polish sentences into something that reads like a style guide wrote it.
