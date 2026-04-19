---
name: ship
description: Build, bump patch version, commit, and push to origin main
allowed-tools: Bash(./ship.sh *)
---

Run the ship script: builds TypeScript, runs `npm link` to update the local `cxms` binary, bumps the patch version in package.json, commits all staged changes (with an optional commit message argument), rebases from origin main, and pushes.

```bash
./ship.sh $ARGUMENTS
```

If no argument is provided, a default timestamped commit message is used.
Report the output to the user when done.
