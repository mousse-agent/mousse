---
name: gh-attach-images
description: Attach local screenshots or videos to a GitHub PR or issue (body or comment) with gh's built-in --attach. Use whenever PR screenshots need posting.
---

# Attach images to a GitHub PR or issue

`gh` 2.99.0+ uploads images and videos itself, to the same `github.com/user-attachments/assets/...` storage as a browser
drag-and-drop. Nothing goes into the repository, so clones don't grow. On a private repo the images stay private.

```
# Into a comment (Markdown in the body that names the local path is rewritten to the uploaded URL):
gh pr comment <N> --body-file body.md --attach ./before.png --attach ./after.png

# Into the PR description (keeps the current body and appends, or rewrites references in a new --body-file):
gh pr edit <N> --body-file body.md --attach './shot.png#Alt text'

# Issues: gh issue create / edit / comment take the same flag.
```

- Write `![Alt text](./before.png)` in the body file and pass the same path to `--attach`. The reference is replaced in place, which is how a before/after table works. Paths in `--body-file` are relative to that file's folder. Files the body doesn't mention are appended at the end. At most 50 files per command, and the same file can't be attached twice.
- Alt text goes after `#` in the `--attach` path. Videos (`.mp4`, `.mov`, `.webm`) become an inline player and take no alt text.
- It needs push access to the repo and an OAuth, classic PAT or fine-grained PAT token (`gh auth status`). GitHub refuses the Actions `GITHUB_TOKEN` and GitHub App tokens.
- Check the version first with `gh --version`. If it is older than 2.99.0, update `gh` instead of working around it.
- Never commit PR images to the repository (an orphan `pr-assets` branch reached ~345 MB in a month and every clone downloaded it).
- Anything attached on a public repo is public. Never attach screenshots that show secrets, keys, account emails or private data.
