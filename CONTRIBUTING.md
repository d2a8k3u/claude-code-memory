# Contributing

Thanks for your interest in contributing to claude-memory!

## Getting Started

```bash
git clone https://github.com/d2a8k3u/claude-code-memory.git
cd claude-code-memory/server
npm install
npm run build
```

### Running Tests

```bash
npm test                # unit + e2e (mocked embeddings)
```

Integration tests require a network connection for the HF model download on first run:

```bash
node --import tsx --test src/__tests__/integration.test.ts
```

### Linting & Formatting

```bash
npm run lint            # eslint
npm run format:check    # prettier
npm run typecheck       # tsc --noEmit
```

Fix issues automatically:

```bash
npm run lint:fix
npm run format
```

## Project Structure

- `server/src/` — MCP server and CLI source
- `server/src/cli/` — Hook handlers (session-start, session-end, error-context)
- `server/src/__tests__/` — Test suite
- `skills/` — Claude Code skills
- `agents/` — Sub-agent definitions
- `hooks/` — Hook config templates

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Ensure `npm test`, `npm run lint`, and `npm run typecheck` pass
4. Commit using [conventional commits](https://www.conventionalcommits.org/): `type(scope): description`
5. Open a pull request

## Code Style

- TypeScript strict mode, ESM modules
- Prettier: single quotes, semicolons, trailing commas, 2-space indent
- No `any` — use `unknown` and narrow
- Keep functions small, names descriptive, comments minimal

## Reporting Issues

Open an issue with:
- What you expected vs. what happened
- Steps to reproduce
- Node.js version and OS
