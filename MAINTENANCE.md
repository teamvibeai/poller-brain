# Base Brain Maintenance

These tasks are universal — they apply to all agents regardless of workspace.
During heartbeat sessions, execute these alongside your channel's HEARTBEAT.md tasks.

## One-Time

- **Memory migration**: If `memory/core/` directory does not exist, run the migration described in the `memory` skill. This splits the old monolithic MEMORY.md into the tiered structure. Only needed once per brain.

## Weekly

- **Memory consolidation**: Check `memory/.last_consolidation`. If 7+ days old (or missing), run the memory-consolidate skill to process daily logs into long-term memory.

## Monthly

- **Memory reflection**: Check `memory/episodic/reflection-*.md` for the last reflection date. If 30+ days old (or none exist), run the memory-reflect skill to assess memory quality.
