# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Japanese-language prototype (グループ形成過程シミュレーター) that visualizes how an informal group forms during an ambiguous social transition — specifically, the moment after a work/social event when it's unclear who's going to an afterparty. It's not a personality quiz; it's an agent-based simulation exploring what conditions make people join vs. give up and leave during that ambiguous window. See `README.md` for the full concept writeup (in Japanese).

The agent type of particular interest is `observerJoiner`: someone who wants to go but avoids influencing group formation themselves, and gives up if the ambiguous phase drags on too long. Most of the tuning work in this codebase exists to make that archetype's behavior (and the contrast between scenario presets) visible and non-trivial rather than deterministic.

## Commands

```bash
npm run dev      # start Vite dev server
npm run build    # tsc -b (typecheck) + vite build — must pass with zero errors
npm run test     # vitest run — simulation logic unit tests
npm run lint     # oxlint
```

Run a single test file: `npx vitest run src/simulation/engine.test.ts`
Run tests matching a name: `npx vitest run -t "observerJoiner"`

There is no test runner config beyond `vitest.config.ts` (node environment, `src/**/*.test.ts` only — no DOM/component tests exist or are expected here).

## Architecture

Simulation logic and rendering are strictly separated:

- `src/simulation/` — pure TypeScript, no React, no DOM. Fully unit-testable in isolation.
  - `types.ts` — `Agent`, `GroupCandidate`, `SimParams`, `SimulationState`. `Agent` extends the spec'd fields with `cliqueId` (internal, models pre-existing friend groups).
  - `random.ts` — `SeededRandom` (Mulberry32). All randomness in the sim goes through this so seeds reproduce runs deterministically.
  - `model.ts` — `createInitialAgents(seed, params)`: builds the starting population, assigns designated leaders, observerJoiner(s), and cliques. Cliques are spatially clustered at creation time.
  - `presets.ts` — `DEFAULT_PARAMS` and the 5 required `PRESETS` (natural formation, ambiguous dissolve, strong leader, late-join culture, leftover free-grouping). Presets are just parameter bundles.
  - `engine.ts` — `createInitialState` + `stepSimulation(state, params, rng) => newState`. One tick = one pass through: core formation → approach decisions → movement/joining → forming/joined jitter → undecided wander → stress accumulation/leaving → group confirmation. Pure function of `(state, params, rng)`, returns a new `SimulationState` — never mutates its input.
  - `interventions.ts` — catalog of intervention scenarios (`InterventionScenarioId`) layered on top of a preset via `paramAdjustments` plus scenario-specific logic in `engine.ts` (gated by `interventionId`). `light-observer-invitation` is the one that directly mutates agent state (`Agent.invitedAtTick`) and temporarily boosts approach probability/reduces stress — see `docs/speech-event-intervention-boundary.md` for how this relates to `SpeechEvent`.
  - `speech.ts` — `SpeechEvent` (Phase 2): a first-class, generation-only record of "who said what" (`speechLog` on `SimulationState`). `createSpeechEvent`/`deriveSpeechEvents` are pure and must never read/mutate `SimulationState` or other agents — hearing a `SpeechEvent` has no effect on any agent's stress/attractiveness/decisions. `engine.ts` is the only caller of `createSpeechEvent`, either directly (rng-selected speakers, e.g. `lightObserverInvitation`) or via `deriveSpeechEvents` (speaker recoverable from a state diff) — never both for the same event, to avoid double-generation.
  - `speechEffects.ts` — Phase 3: the causal chain from a `SpeechEvent` through `SpeechReceptionEvent` → `SpeechInterpretationEvent` → `SpeechEffectEvent` (`deriveSpeechReceptions`/`deriveSpeechInterpretations`/`deriveSpeechEffects`, all pure, linked by `speechEventId`/`receiverId`). Gated by `SpeechEffectsConfig.enabled` (default `false`, backward compatible); `engine.ts` threads the three stages explicitly and accumulates results on `SimulationState.speechReceptionLog`/`speechInterpretationLog`/`speechEffectLog`. These records are structural only — nothing in the codebase applies `SpeechEffectEvent.outputValue` back onto `Agent.stress` or any decision yet (that's a later phase). See `docs/speech-effects-phase3-boundary.md`.
- `src/components/` — presentational only, takes `SimulationState` slices as props and renders SVG (`SimulationCanvas`) or lists (`EventLog`, `ControlPanel`, `AgentLegend`). No simulation rules live here.
- `src/App.tsx` — owns `SimulationState`, `SimParams`, `seed`, `presetId`, `running` as React state; drives ticks via `setInterval` (Start/Pause) or manually (Step); owns the single `SeededRandom` instance in a ref across ticks.

### Key behavioral rules (all in `engine.ts`) — read before touching tuning constants

These were arrived at through iteration, not first-principles — changing constants without re-testing all 5 presets will likely silently break the intended contrast between them:

- **Stress only accumulates while `state === "undecided"`.** Once an agent starts `approaching`/`forming` they've "decided" and are no longer in the ambiguous phase — they won't flip to `leaving` mid-transit even if slow to arrive. (Originally stress applied during approach too, which caused everyone to give up before ever reaching a group — a real bug found via manual browser verification, not caught by unit tests.)
- **Only agents with `initiative >= 0.5` can spontaneously found a core** (`forming`), unless they're in a clique (`cliqueId` set) with `existingTieStrength > 0.5` and enough clique-mates are nearby — in which case a pre-existing friend group can self-organize without a designated leader. This is what makes `numLeaders: 0` presets actually produce "nobody starts anything."
- **`attractiveness()` computes a per-candidate score** combining willingness/conformity/influenceAvoidance, a same-clique bonus, and an outsider penalty that scales with how dominated a group is by a single clique (`dominantClique()`). The penalty only reduces the *probability* of deciding to approach each tick — it does not block arrival once approaching, so over enough ticks even a "closed" clique is eventually breachable. Genuine isolation in preset 5 comes from the observerJoiner's stress crossing `leaveThreshold` *before* that low-probability approach roll succeeds, not from a hard block. This is inherently probabilistic — verified by running preset 5 across multiple seeds (`node` + Playwright script driving the built dev server), not by a single deterministic test.
- `observerJoiner` gets extra stress specifically when no *welcoming* confirmed group exists (`hasWelcomingConfirmedGroup` — a confirmed group counts as welcoming unless it's clique-dominated by a clique the agent doesn't belong to). A naive "any confirmed group exists" check was tried first and made the archetype join almost every scenario, defeating the point of preset 5.

If you change stress rates, approach speed (`APPROACH_SPEED`), or the outsider-penalty coefficients, re-verify by actually running the dev server and driving it (Playwright/headless browser or manual), across a few different seeds per preset — the unit tests check individual rule mechanics in isolation but won't catch "every preset now behaves identically" regressions.

## Testing conventions

`src/simulation/*.test.ts` tests only the logic layer (no component/DOM tests exist). Tests construct `SimulationState`/`Agent` objects directly (see `makeAgent()` helper in `engine.test.ts`) rather than always going through `createInitialState`, to isolate specific rules. Where a test needs to distinguish "chose to move toward a group" from "arrived and joined," place the candidate far enough away that one tick can't cover the full distance — see the comment in `engine.test.ts`'s observerJoiner approach test for why.
