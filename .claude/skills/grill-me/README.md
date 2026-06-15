# grill-me

A Claude Code skill for structured interrogation of plans, designs, and ideas. It acts as a sharp, collegial interviewer that stress-tests your thinking by probing assumptions, surfacing risks, and tracking decisions.

In this repository the skill is committed under `.claude/skills/grill-me/` so it is available to every Claude Code session on this project — including Claude Code on the web — without per-machine installation.

## Installation

This skill is already vendored into the repo at `.claude/skills/grill-me/`, so no installation is needed for sessions working in this repository. Claude Code automatically detects project-level skills.

To use it globally on your own machine, copy the directory into your personal skills folder instead:

```
~/.claude/skills/grill-me/
├── SKILL.md
└── README.md
```

Claude Code will automatically detect the skill. No additional configuration is required.

## Compatibility

This skill works with:

- Claude Code CLI (terminal)
- Claude Code desktop app (the Code tab in Claude Desktop on Mac/Windows)
- Claude Code on the web

It does **not** work with the regular Claude desktop app or claude.ai — skills are a Claude Code-specific feature.

## Usage

Invoke the skill by saying any of:

- "grill me"
- "grill me about [topic]"
- "stress test my plan"
- "poke holes in this"

The skill will ask for a short session name, then walk through your plan branch by branch — challenging assumptions, finding gaps, and recording decisions in a persistent session file at `grill-me-sessions/<plan-name>.grill.md`.

## What it does

- Interviews you about your plan without executing it
- Tracks decisions, deferred items, and open threads in a session file
- Reads relevant code and docs to ask informed questions
- Resumes previous sessions where you left off

## What it does not do

- Write code, scripts, or deliverables
- Execute the plan being discussed
- Review or refactor existing code (use code review tools for that)

## Attribution

This skill is vendored from [stevegsax/grill-me](https://github.com/stevegsax/grill-me). Per that project's notes, the prompt was inspired by several seen on the web; multiple people claim authorship, among them:

- [mattpocock](https://github.com/mattpocock/skills/tree/main)
- [AIHero.dev](https://www.aihero.dev/my-grill-me-skill-has-gone-viral)
