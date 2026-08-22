# Canonical Mastery Architecture

## Rule

One platform. One data model. One Emma.

Do not create another standalone Studio, Command Center, messaging agent, knowledge base, or Emma memory system.

## Product surfaces

### 1. Mastery Studio

Audience: leaders, coaches, experts, teams, organizations.

Purpose: develop people and operate the organization's Mastery experience.

Primary navigation:

- Home
- People
- Knowledge
- Tools
- Programs
- Intelligence
- Settings

Home is Emma-first. Vision, Mission, and Weekly Theme are first-class shared organization state.

Studio can deploy a tool or program to one person, a group, or an entire team through the app or messaging layer.

### 2. Mastery Command Center

Audience: Mastery internal operators.

Purpose: build, deploy, inspect, and administer the system.

Primary navigation:

- Organizations
- People
- Agents
- Activity
- Knowledge
- Integrations
- System

Core actions:

- create/configure an organization
- add/import people
- create/select an agent
- give the agent a task
- send by text or call
- inspect conversations and transcripts
- extract/review knowledge
- publish knowledge/tools/programs into Studio/Mastery
- inspect system health and integrations

### 3. Mastery

Audience: end users.

Purpose: receive coaching, training, programming, tools, and follow-up.

Mastery is a delivery surface, not a separate intelligence system.

## Shared Core Platform

Everything below both Studio and Command Center uses the same services and records.

### Identity

A person has one Mastery identity across phone, app, Studio, voice, and email where available.

### Organizations and memberships

A person can belong to one or more organizations with explicit roles and permissions.

### Living Profile

Personal evolving context belongs to the person and is permission scoped.

### Organization intelligence

Shared organizational state includes:

- Vision
- Mission
- Weekly Theme
- principles
- language
- standards
- knowledge
- tools
- programs
- team structures
- deployment rules

### Conversations

Text, phone, app, and Studio chat write into one conversation/memory layer.

### Emma

Emma is a channel-independent agent over the Core Platform.

Before responding, Emma receives permission-scoped context from the shared platform.

Emma must never say she cannot see Studio when the requested value exists in the shared state.

Emma can write approved updates back to the same state.

### Knowledge

Documents, interviews, transcripts, approved insights, coach knowledge, team knowledge, and sources belong to one knowledge layer with provenance and permissions.

### Tools and programs

Tools are reusable objects. Programs orchestrate tools over time.

Both can be assigned to a person, group, or team and delivered through the Mastery app or messaging channels.

### Events and activity

Every meaningful action should produce a durable event: message received, call completed, knowledge approved, tool assigned, program completed, Studio field updated, etc.

## Repository boundaries

`src/` currently contains Core Platform production services.

`apps/studio/` is the only future production Studio web surface.

`apps/command-center/` is the only future production Command Center web surface.

Old `*.chatgpt.site` prototypes are design references only. Do not add production state or backend logic to them.

## Migration rule

When useful functionality exists in an old prototype:

1. identify the underlying behavior/data
2. implement it in the Core Platform
3. expose it through the canonical Studio or Command Center
4. migrate required data
5. retire the old path

Do not wire new features into an old prototype as a shortcut.

## Immediate build order

1. Shared auth, organization, membership, and permission model.
2. Canonical Studio shell backed only by Core Platform APIs.
3. Canonical Command Center shell backed only by Core Platform APIs.
4. Move Vision/Mission/Weekly Theme and organization knowledge fully into shared organization state.
5. Make Emma's context resolver permission-aware across all Studio state.
6. Consolidate conversations, transcripts, and Living Profile persistence.
7. Add people, tools, programs, assignments, and deployment objects.
8. Migrate useful prototype data and retire prototype URLs.
