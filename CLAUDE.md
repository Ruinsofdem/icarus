## Token efficiency (every session)

- Be terse. No preamble, no restating the request, no recap beyond a 1–3 line result.
- Locate before reading: Grep/Glob first, then read only the relevant line ranges. Never re-read a file you just edited.
- Edit in place. Don't rewrite whole files or paste file contents or large diffs into chat.
- Don't explore the repo "for context". For broad searches, delegate to an Explore subagent and keep only its conclusion.
- Batch independent tool calls in one turn. Trim noisy command output (`| tail -n 30`, `grep`, quiet/dot reporters).
- Take the sensible default and proceed. Ask only when blocked on a decision that is genuinely the user's.
- Don't create reports, docs, or summary files unless asked.
- Load reference docs (design spec, framework docs) only when the task touches that area.
- When writing or revising a production prompt (e.g. an ICARUS agent or chat system prompt), apply the `token-reduction` skill.
