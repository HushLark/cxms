---
name: ship
description: Build, bump patch version, commit, and push to remote. GitHub Actions publishes to npm.
allowed-tools: Bash(./ship.sh *)
---

Run the ship script to build, bump the patch version, commit all changes, pull --rebase, and push.

```bash
./ship.sh $ARGUMENTS
```

If no argument is provided, a default version-bump commit message is used.
The GitHub Action `.github/workflows/publish.yml` auto-publishes to npm when the version changes.
Report the output to the user when done.
