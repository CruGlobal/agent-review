# Description

<!-- What does this PR change, and why? Link any related issues or PRs. -->

# Checklist

- [ ] 🔤 PR title prefixed with Jira ticket number (Ex: `MPDX-123: <insert title here>`)
- [ ] 👀 Assign myself to the PR
- [ ] ✅ Tests are passing (`npm test`; `npm run check-dist` if `engine/` changed)
- [ ] 🤖 AI review findings addressed (or noted above as deliberately skipped)
- [ ] 🎉 Passes QA
- [ ] ⬆️ Upgrade the version if needed — bump `.claude-plugin/plugin.json`, `package.json`, and the template markers, run `npm run stamp-templates`, then after merge:
      `git checkout main && git pull origin main && git tag vX.X.X && git push origin vX.X.X`
