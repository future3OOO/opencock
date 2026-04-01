---
name: mission-wake
description: "Dispatch mission completion awareness from source-owned runtime hooks"
homepage: https://docs.openclaw.ai/automation/hooks#mission-wake
metadata:
  {
    "openclaw":
      {
        "emoji": "📣",
        "events": ["agent:mission:completed", "gateway:startup"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Mission Wake Hook

Triggers source-owned mission wake dispatch when delegated work completes and replays pending
mission wakes on gateway startup.
