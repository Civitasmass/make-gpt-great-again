---
name: gpt
description: Delegate work to GPT-5.6 or get an independent second opinion from it, through the mgga bridge. Use PROACTIVELY when a task benefits from cross-model verification (audits, gnarly diagnoses, design reviews, "am I sure about this?"), when bulk mechanical work can be offloaded cheaply, or whenever the user asks for GPT by name — in any language — or wants a second opinion. Covers channel choice (ask_gpt tool, gpt/gpt-quick/gpt-deep subagents, mgga ask CLI), effort tiers, and writing briefs GPT can execute with zero shared context.
---

# Working with GPT-5.6 (the mgga bridge)

You have a second frontier model on tap. It shares NONE of your conversation
state — every channel below is stateless, so the brief is everything.

## Pick the channel by the shape of the work

| Shape | Channel | Notes |
|---|---|---|
| Question, review, opinion — no tools needed | `ask_gpt` MCP tool | One call; paste ALL relevant code/context into the prompt |
| Self-contained task needing tools (read/edit/run) | `Task(subagent_type: "gpt")` | Full tool loop, own context; needs mgga mixed mode |
| Bulk mechanical work (renames, boilerplate, triage) | `Task(subagent_type: "gpt-quick")` | Luna — cheap and fast; wrong-answer risk must be cheap too |
| Hardest problems — root-cause hunts, design review where wrong = expensive | `Task(subagent_type: "gpt-deep")` | Sol at :max — slow, quota-hungry, worth it rarely |
| From a shell / pipeline | `mgga ask -m gpt-5.6-sol:high "…"` | stdin pipes in: `git diff \| mgga ask "review"` |

Model tiers: **sol** = frontier, **terra** = balanced, **luna** = fast.
Efforts `low…ultra` ride a model suffix: `gpt-5.6-sol:max`.

## When to reach for it proactively

- **Cross-examination**: you finished something load-bearing and want an
  independent audit that doesn't share your blind spots. GPT re-deriving your
  conclusion from the raw files is worth more than you re-reading yourself.
- **Second diagnosis**: you've been stuck twice on the same bug. Hand the
  symptoms (not your theory!) to `gpt-deep` — a fresh frame beats more depth
  in the same frame. Do not include your current hypothesis in the brief;
  that would just infect the second opinion.
- **Parallel offload**: mechanical work that would burn your context —
  `gpt-quick` does it while you keep the main thread.
- **Taste tiebreaks**: two designs, you're 55/45 — ask for a ranked verdict
  with reasons, then decide yourself.

## Writing the brief (the part that decides everything)

GPT sees nothing you don't paste. A good brief has:

1. **Goal in one sentence**, then constraints (style, deps, what NOT to touch).
2. **Absolute file paths** and the repo root; quote key snippets inline when
   they're load-bearing (don't make it re-discover what you already know).
3. **Acceptance check**: the command to run or the property to verify.
4. **Report format**: "report: what changed, what you verified, what remains."

## After it returns

Trust but verify — its summary describes intent, not necessarily fact. Diff
what it touched, run the acceptance check yourself. On disagreement between
your view and its view, the tiebreak is evidence from the actual code, never
seniority of either model.

## Ops notes

- Subagent channels need the mgga proxy up (the launchers auto-start it) and
  mixed mode for real-Claude sessions.
- GPT usage bills to the ChatGPT subscription quota — visible at
  `GET localhost:5656/quota`. Deep tiers are expensive; match tier to stakes.
- If a call fails with auth errors twice, the Codex login needs a refresh
  (`codex login` or run the Codex CLI once).
