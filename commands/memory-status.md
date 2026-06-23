---
description: Show a memory health digest for this project (items, sessions, injections served)
---

Run this Bash and relay the digest to the user. It reads the project's memory database and prints counts, embedding/reranker status, never-injected dead weight, and relation-graph metrics.

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/dist/cli.js" status
```

Then briefly summarize the headline (items / sessions / injections served) and flag anything notable: embeddings or reranker reported as "down", a high never-injected count, or low embedding coverage.
