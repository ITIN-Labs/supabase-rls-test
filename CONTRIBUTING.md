# Contributing

Thanks for helping. Bug reports with a small reproduction are the most useful thing you can send. For anything bigger than a fix, open an issue first so we can agree on the approach before you write it.

## Setup

You need Node 22.18 or later; the tests run TypeScript directly with Node's type stripping.

```sh
npm ci
npm test            # tests with coverage
npm run lint        # ESLint and Prettier
npm run typecheck   # tsc, including the public type tests in test/types.check.ts
npm run build && npm run check:package   # publint, are-the-types-wrong, size budget
npm run format      # fix formatting
```

CI runs all of these on every pull request, plus CodeQL, a dependency audit and a check that no ignored files are tracked.

## How changes are judged

The simplest change that fully solves the problem wins. Before adding code, check whether it needs to exist, whether the codebase, Node or an existing dependency already does it, and whether it can be smaller. New options, files and dependencies each need a real use, not a possible one. Shortcuts are fine when they're marked with a `shortcut:` comment saying what was skipped and when it would matter.

Never cut validation of outside input, handling that prevents data loss, or security measures.

Anything with a branch, a loop or a parser gets a test, including the failure path. Tests use made-up data only, never real user data.

If users will notice the change, add a changeset with `npm run changeset` and start its summary with Added, Changed, Fixed, Security or Breaking.

## Writing

This applies to docs, comments, test names, error messages and commit messages.

- Be specific and brief. Say what something does, not how great it is.
- Leave out marketing language.
- Use little formatting: few bold words, no emoji, sentences where they read better than bullets.
- Comments explain why, not what.
- Error messages say what went wrong and how to fix it, and never repeat sensitive input.
- Commit messages are short and imperative: "Fix off-by-one in range check".

## AI tools

AI-assisted contributions are welcome. You're responsible for what you send: you've read all of it, run the checks, and it meets the standards on this page. [AGENTS.md](AGENTS.md) gives coding agents the same rules.

## Code of conduct

Everyone taking part agrees to the [code of conduct](CODE_OF_CONDUCT.md).
