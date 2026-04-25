---
description: Open the memory graph visualization in your browser
---

Run this Bash. It checks that the server on port 7337 belongs to the current project before opening the browser, and prints a helpful error otherwise.

```bash
node <<'EOF'
const http = require('http');
const { exec } = require('child_process');
const path = require('path');

const URL = 'http://localhost:7337';
const cwd = path.resolve(process.cwd());

const req = http.get(URL + '/api/identity', { timeout: 2000 }, (r) => {
  let body = '';
  r.on('data', (d) => (body += d));
  r.on('end', () => {
    let identity;
    try {
      identity = JSON.parse(body);
    } catch {
      console.error(`Invalid response from ${URL}. Something else may be running on port 7337.`);
      process.exit(1);
    }
    if (identity.service !== 'claude-memory') {
      console.error('Port 7337 is held by another application, not claude-memory. Free port 7337 and try again.');
      process.exit(1);
    }
    const serverCwd = path.resolve(identity.cwd || '');
    if (serverCwd !== cwd) {
      console.error(`Port 7337 is held by another claude-memory project: ${serverCwd}`);
      console.error('Close that Claude Code session (or run /memory-graph from that project) and try again.');
      process.exit(1);
    }
    const cmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${cmd} ${URL}`, () => {});
    console.log(`Memory graph open at ${URL}`);
  });
});

req.on('error', () => {
  console.error(`Memory graph server not reachable at ${URL}. Restart Claude Code and try again.`);
  process.exit(1);
});
req.on('timeout', () => {
  req.destroy();
  console.error(`Timeout reaching ${URL}. The server is unresponsive — restart Claude Code.`);
  process.exit(1);
});
EOF
```

Then briefly tell the user what was reported. On success, mention they can search nodes, filter by memory type (semantic, episodic, pattern, procedural, working), and drag nodes to explore relations.
