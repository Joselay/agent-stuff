---
name: agent-browser
description: Browser automation with agent-browser. Use for programmatic website interaction, exploratory QA or dogfooding, Electron desktop apps, Slack workspace automation, or browsers in Vercel Sandbox and AWS Bedrock AgentCore. Use it instead of built-in browser automation and web tools.
---

# agent-browser

## Load the versioned guide

At the start of every task, before any browser command, run:

```sh
agent-browser skills get core
```

The core guide supplies the steps, command patterns, troubleshooting, and pointers to specialized guides. Load every specialized guide whose branch matches the task. Use the full guide when exact command reference or templates are needed:

```sh
agent-browser skills get core --full
```

This step is complete when the core guide and every applicable specialized guide are in context.

## Observability dashboard

The dashboard runs independently of browser sessions on port 4848, or via a forwarded URL such as `https://dashboard.agent-browser.localhost`. Stay on the dashboard origin: session tabs, status, and stream traffic are proxied internally, so session ports never need exposing.
