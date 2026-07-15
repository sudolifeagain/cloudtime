# Feature Specification: AI Coding Model Attribution Onboarding

**Feature Branch**: `201-ai-attribution-onboarding`

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "A guided setup step that helps the owner get AI coding heartbeats attributed to a concrete model, focused on the Codex case. Codex usage arrives as a known provider but an unknown model, so it buckets under 'unknown' and is excluded from the estimated cost, because the compatible Codex client (through its current release) does not put the active model in its identity string. A one-time client-side setup already exists but owners only discover it after noticing 'unknown'. The system is a server and cannot automate the owner's machine, so it must detect the unattributed state from data it already stores, guide the owner through the one-time local setup, and confirm resolution — surfaced both reactively in the dashboard and proactively during initial setup."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Guided fix when Codex usage is unattributed (Priority: P1)

An owner who codes with a compatible Codex client sees their recent aggregated AI coding
activity bucketed under a known provider with an **unknown** model, and the
estimated cost excludes that usage. Instead of having to notice the gap, guess
the cause, and hunt through documentation, the owner dashboard shows a clear,
guided setup step next to the AI coding activity: it explains *why* Codex usage
is unattributed, gives the exact **one-time** steps the owner runs on their own
workstation to fix it (run the provided setup; optionally set a default model),
and links to the full written instructions. The owner follows the steps once.

**Why this priority**: This is the core value — it converts a silent, confusing
"unknown" state into a self-service fix. It is a complete, shippable improvement
on its own, even without the later stories.

**Independent Test**: With stored AI usage that has a known provider but an
unknown model in the recent window, load the owner dashboard and confirm the
guided setup step appears with the correct explanation, steps, and link; with no
such usage, confirm it does not appear.

**Acceptance Scenarios**:

1. **Given** recent AI coding usage attributed to OpenAI but an unknown model, **When** the owner opens the dashboard, **Then** a guided setup step is shown that explains the cause, lists the exact one-time Codex setup steps, and links to the full instructions. For another recognized provider without tailored guidance, the step instead gives generic attribution guidance and a generic troubleshooting link; it never shows the Codex command.
2. **Given** the owner has no provider-known/model-unknown usage in the recent window, **When** the owner opens the dashboard, **Then** no setup step is shown.
3. **Given** the setup step is shown, **When** the owner reads it, **Then** it never displays or requests any secret, credential, or the owner's raw local configuration values.

---

### User Story 2 - Confirming the fix and not nagging afterward (Priority: P2)

After the owner completes the one-time setup, new Codex heartbeats begin carrying
a concrete model. Once the hourly aggregation incorporates those heartbeats and
the trailing summary no longer contains unattributed usage, the dashboard stops
prompting. Historical "unknown" usage ages out of the same trailing window, so it
does not create a permanent prompt.

**Why this priority**: Closes the loop and keeps the guidance from becoming
noise. Without it, the P1 step could nag indefinitely on old data.

**Independent Test**: Start with recent unattributed usage (step shows); use a
post-aggregation summary with only concrete-model usage in the trailing window;
reload and confirm the step disappears. Confirm that old, out-of-window unknown
usage alone does not keep it visible.

**Acceptance Scenarios**:

1. **Given** the setup step was shown, **When** the next hourly aggregation includes new AI usage in the recent window with a concrete model and no provider-known/model-unknown usage remains in that window, **Then** the step is absent and no longer prompts for action.
2. **Given** only historical (out-of-window) unknown usage exists, **When** the owner opens the dashboard, **Then** the step does not prompt.

---

### User Story 3 - Proactive attribution setup during initial onboarding (Priority: P3)

A new owner setting up their instance is guided to get AI coding attribution right
from the start, as part of the initial setup experience — before accumulating a
pile of "unknown" usage. The onboarding presents the AI coding attribution step,
distinguishing tools that attribute automatically (Claude Code) from tools that
need the one-time setup (Codex), so the owner can prepare it proactively.

**Why this priority**: This is the fuller "setup wizard" ambition. It is valuable
but reuses P1's guidance content and detection concepts; it can ship after the
reactive path has proven the content.

**Independent Test**: As a fresh owner with no AI usage yet, enter the initial
setup experience and confirm an AI coding attribution step is presented with the
correct per-tool guidance, independent of whether any heartbeats exist.

**Acceptance Scenarios**:

1. **Given** a newly set-up instance with no AI usage, **When** the owner goes through initial setup, **Then** an AI coding attribution step explains that Claude Code attributes automatically and Codex needs the one-time setup, with the same instructions and link.
2. **Given** the owner only ever uses a client that already attributes its model, **When** they complete setup, **Then** the attribution step communicates that no extra action is required.

---

### Edge Cases

- **Claude-Code-only owner**: no reactive prompt ever appears, and the proactive step states that no action is needed.
- **Already fixed before any prompt**: the owner applied the setup early, so recent usage is attributed and no prompt is shown.
- **Only frozen historical unknowns** (from before the fix): the reactive prompt does not appear, because detection is scoped to recent activity — old "unknown" rows do not nag forever.
- **A future non-Codex tool** produces provider-known/model-unknown usage: the guidance names the affected provider generically and links to generic AI attribution troubleshooting; it never offers the Codex-specific command.
- **Mixed recent usage** (some attributed, some not): the prompt appears while any unattributed portion remains in the window and clears once none remains.
- **Transient gap**: any provider-known/model-unknown usage remains actionable for the rest of the trailing window. The step clears only when no such aggregate remains in that window.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST detect, from already-stored AI coding usage, when recent activity is attributed to a known provider but no concrete model (a "provider-known, model-unknown" state), scoped to a recent activity window.
- **FR-002**: When such a state exists, the owner dashboard MUST present a guided setup step adjacent to the AI coding activity summary. It MUST explain in plain language why the usage is unattributed and link to full written instructions. A tool with tailored guidance MAY show its exact one-time workstation steps; a provider without tailored guidance MUST instead show generic attribution troubleshooting and MUST NOT show another tool's command.
- **FR-003**: The guided step MUST make clear that the fix is performed on the owner's own machine and that the system only provides instructions — it MUST NOT claim to have changed the owner's client or configuration.
- **FR-004**: The system MUST NOT display, request, or store any secret, credential, API key, or the raw contents of the owner's local configuration within the guidance.
- **FR-005**: The guidance MUST NOT appear for owners who have no provider-known/model-unknown usage in the recent window (e.g., owners who only use a client that already attributes its model).
- **FR-006**: Once the hourly aggregation contains recent usage with concrete models and no provider-known/model-unknown usage remains in the recent window, the system MUST stop prompting for action (auto-resolve).
- **FR-007**: Frozen historical unattributed usage that falls outside the recent window MUST NOT, on its own, keep the guidance visible.
- **FR-008**: The guidance MUST identify which tool's usage is unattributed so the owner knows what to set up, and MUST degrade gracefully to generic attribution troubleshooting when the specific tool has no tailored instructions. Generic guidance MUST NOT offer an instruction or command intended for another tool.
- **FR-009** *(P3)*: The system MUST present equivalent attribution guidance during initial owner setup, independent of whether any AI usage exists yet, distinguishing tools that attribute automatically from tools that need the one-time setup.
- **FR-010**: The feature MUST NOT change how usage is priced or how costs are computed; unattributed usage continues to be excluded from cost estimates (never a silent zero), exactly as today.
- **FR-011**: All owner-facing text MUST be original and refer to compatible clients in a trademark-compliant way (e.g., "WakaTime-compatible"), consistent with project policy.

### Key Entities *(include if feature involves data)*

- **Attribution status** (derived, not newly persisted): a per-owner, recent-window summary computed from existing AI coding usage — whether any usage is provider-known/model-unknown, and which provider/tool it came from. Drives whether, and what, the guidance shows.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner who uses Codex can go from seeing unattributed ("unknown") AI usage to correctly attributed per-model usage by following only the on-screen guidance, with no external help, in a single setup session.
- **SC-002**: After the owner completes the setup, effectively all of their new AI coding usage over the following recent window is attributed to a concrete model; after the remaining unknown groups age out and the next aggregation runs, the "unattributed" prompt no longer appears.
- **SC-003**: Owners with no unattributed usage (e.g., Claude-Code-only) are never shown a corrective prompt (zero false prompts).
- **SC-004**: The guidance never exposes a secret or a raw local configuration value (zero incidents).
- **SC-005**: Estimated cost and token figures for any given underlying usage are unchanged by this feature (it is presentation and guidance only).
- **SC-006**: Historical, out-of-window "unknown" usage does not produce a standing prompt; the prompt reflects only recent, actionable state.

## Assumptions

- The one-time client setup already exists and is maintained by the project (a documented Codex model-attribution setup: the provided patch script plus an optional default model and reasoning effort in the Codex configuration). This feature surfaces and guides that existing setup; it does not invent a new attribution mechanism.
- "Recent window" for detection reuses the trailing window already used for the AI coding activity summary (default ~30 days) unless a shorter, more responsive window is chosen during design. The exact length is a design detail, not a scope change.
- Detection relies only on data the system already stores for AI coding usage (provider and model per usage bucket); no new client data collection is required.
- The dashboard reads a cron-maintained aggregate, so the attribution state updates on the next hourly aggregation rather than immediately when a heartbeat arrives.
- The canonical live instance runs in single-user mode; "owner" is the sole authenticated user. Multi-user behavior is out of scope.
- Claude Code already attributes its model automatically and needs no corrective guidance; Codex is the current tool that needs the one-time setup. The tool-specific parts are kept data-driven so additional tools can be added without reworking the feature.
- This is a presentation/onboarding feature; it introduces no change to pricing, aggregation, or heartbeat ingestion.
