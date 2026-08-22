# Mastery Platform

This repository is the canonical codebase for the Mastery operating platform.

There are three product layers and only three:

1. **Mastery Studio** — for leaders, coaches, teams, and organizations.
2. **Mastery Command Center** — internal operations for Mastery.
3. **Core Platform** — shared identity, data, knowledge, agents, messaging, voice, permissions, and orchestration.

Mastery itself remains the end-user delivery experience.

## Mastery Studio

Studio is where a leader or organization runs its Mastery system.

Canonical areas:

- Home / Emma
- Vision, Mission, Weekly Theme
- People and teams
- Knowledge base
- Tools and programs
- Assignments and deployment
- Team intelligence and progress
- Organization settings and permissions

Emma must read the same Studio state the UI reads and write changes back to that same state.

## Mastery Command Center

Command Center is the internal operating system used by Mastery.

Canonical areas:

- Organizations
- People
- Agents
- Tasks
- Conversations
- Text and voice deployment
- Interviews and knowledge capture
- Integrations
- Activity and system health
- Infrastructure administration

Command Center operates the system. Studio is the customer/leader product.

## Core Platform

The shared backend owns:

- identities
- organizations and memberships
- permissions
- Living Profiles
- organization knowledge
- conversations and transcripts
- Studio state
- tools and programs
- agent configuration and orchestration
- Linq messaging
- Twilio voice
- document and knowledge ingestion
- deployment and activity events

There must never be a separate Emma memory or separate Studio database per channel.

## Current backend

The current TypeScript service in `src/` is the beginning of the Core Platform. It already contains Studio state, Emma context, Linq messaging, Twilio voice, and Render administration.

New product work should follow `docs/CANONICAL_ARCHITECTURE.md`.

Old ChatGPT-site prototypes are reference designs only. They are not sources of truth and should not receive new production logic.
