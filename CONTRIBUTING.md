# Contributing to OpenCursor

Thanks for taking a look. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an [issue](https://github.com/noah-thing/open-cursor/issues/new) with:

- your OS and the OpenCursor version (Help > About)
- the model or subscription you were using
- what you did, what you expected, and what happened instead
- a screenshot when it is about the interface

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Most of OpenCursor lives in `extensions/open-cursor`. Build it with `npm ci` and `node .esbuild.mts` in that folder.
3. Run `npm run typecheck` there, and the unit tests next to the code you changed (`src/**/test`).
4. Keep changes to upstream VS Code files small, so newer Code - OSS releases keep merging cleanly.
5. Describe what changed and why, with a screenshot for anything visual.

[ARCHITECTURE.md](docs/open-cursor/ARCHITECTURE.md) explains how the pieces fit together.

## Questions

Open an issue, or ask [@fsconfig](https://x.com/fsconfig) on X.
