# Mastery Messaging + Agent System — Engineering Handoff

## Purpose

This repository contains the current Mastery messaging and voice-agent implementation. The goal is to let Mastery agents interact with people through iMessage-style text and phone calls while Mastery Studio controls agents, tasks, people, conversations, and knowledge.

## Repository

- Repo: `ericdoak1/MasteryStudio`
- Primary branch: `main`
- Handoff branch: `engineering-handoff`
- Runtime: Node.js / TypeScript
- Containerized with Docker
- Deployment config: Render (`render.yaml`)

## Current Architecture

### Text

Linq number → Mastery webhook/API → text agent → reply in same thread

### Voice

Twilio number → Mastery voice endpoint → OpenAI Realtime → caller

### Control layer

Mastery Studio / Command Center → agent prompt + task → person → conversation → transcript → extracted knowledge

## Current Source Layout

- `src/server.ts` — primary HTTP server, webhook/endpoints, voice and messaging flow
- `src/linq.ts` — Linq messaging integration
- `src/mastery-prompt.ts` — Mastery Coach / agent prompt behavior
- `src/config.ts` — environment/config validation and runtime configuration
- `src/twiml.ts` — Twilio TwiML helpers
- `test/` — automated tests
- `.env.example` — required environment-variable template
- `Dockerfile` — service image
- `render.yaml` — Render web-service deployment definition

## Required External Accounts / Access

Engineering needs access to the following accounts. Do not store live secrets in GitHub or this document.

1. GitHub — repository access to `ericdoak1/MasteryStudio`
2. Render — access to the deployed `mastery-voice-agent` service and environment variables
3. Twilio — account access, phone number configuration, webhook configuration, call logs
4. Linq — dashboard access, iMessage number, API token/webhook configuration
5. OpenAI — API project used by this service
6. Mastery backend — profile/context endpoint if enabled

## Required Environment Variables

See `.env.example` for the canonical list.

- `OPENAI_API_KEY`
- `PUBLIC_BASE_URL`
- `PORT`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_FROM_NUMBER`
- `OUTBOUND_API_KEY`
- `OPENAI_REALTIME_MODEL`
- `OPENAI_VOICE`
- `MASTERY_PROFILE_URL`
- `MASTERY_PROFILE_TOKEN`
- `LINQ_API_TOKEN`
- `LINQ_WEBHOOK_SECRET`
- `OPENAI_TEXT_MODEL`

Live values should be transferred through the account dashboards or a secure secrets manager, not Slack/email/chat.

## Current Runtime Defaults

- Twilio from-number template currently points to `+15039144682`
- OpenAI Realtime model default: `gpt-realtime-2.1`
- OpenAI voice default: `marin`
- OpenAI text model default: `gpt-5-mini`

These are configuration defaults, not proof that every production credential is currently populated.

## Product Decisions Already Made

- Linq is the iMessage/text layer.
- Twilio is the phone/voice layer.
- Text and voice should feel like one Mastery identity.
- A person is primarily resolved by phone number for this communication layer.
- Agents are launched from the Command Center.
- Each launch has an **Agent Prompt** and a **Task**.
- Different flows can route to different agents while using the same phone number.
- Voice agents should be able to call a person and conduct an interview/task.
- Conversations become transcripts.
- Transcripts feed knowledge extraction.
- Extracted knowledge should be stored against the organization/project.
- Mastery Studio is the control/infrastructure layer.
- Mastery is the end-user delivery system.

## Initial Agent Set

### 1. Onboarding Agent
Gets a new person into Mastery.

### 2. Expert Interview Agent
Interviews coaches, experts, athletes, or team members and extracts their knowledge.

### 3. Task Agent
Receives a specific conversational task and completes it with a person via text or voice.

Do not expand the agent count until the core delivery loop is reliable.

## Core Workflow To Complete

Create Organization → Add Person → Select Agent → Enter Agent Prompt + Task → Send via Text or Call → Conduct Conversation → Store Transcript → Extract Knowledge → Review/Approve → Save to Organization Knowledge Base

## Primary Acceptance Test

The first production-quality loop should be:

1. Open Mastery Command Center.
2. Choose **Expert Interview Agent**.
3. Enter/select a person's phone number.
4. Enter the task.
5. Person receives a text from the Mastery/Linq identity.
6. Agent conducts the conversation in that thread.
7. Conversation/transcript appears back inside the correct organization.
8. Extracted knowledge is visible for review.

Then repeat the same workflow using an outbound phone call through Twilio.

## Known / Remaining Engineering Work

- Verify production Linq → Mastery webhook routing end-to-end
- Verify outgoing Linq replies and thread continuity
- Add durable person/conversation persistence if not already backed by production storage
- Formalize agent selection/routing
- Wire Command Center agent/task launches into messaging backend
- Verify Twilio inbound calling in production
- Complete outbound calling path and authorization
- Store transcripts durably
- Add automatic structured knowledge extraction
- Add human approval/edit step for extracted knowledge
- Connect approved knowledge to organization/project knowledge base
- Add organization/user permissions
- Add team access and auditability
- Verify Mastery profile/context lookup where required
- Add observability for failed webhooks, failed sends, call failures, and model errors
- Confirm retries/idempotency for inbound webhook events
- Add basic abuse/rate limits around outbound actions

## Security / Handoff Notes

- Do not commit production secrets.
- Rotate any credentials that have previously been shared directly with people instead of through secure access controls.
- Give engineers named accounts where supported instead of sharing the founder login.
- Verify Twilio webhook signature validation is enabled in production.
- Verify Linq webhook verification is enabled when the provider supports it.
- Keep `OUTBOUND_API_KEY` private; outbound-call endpoints must not be public without authentication.

## What Is Not Part Of This Handoff

Fundraising, investor/legal work, partnership decks, unrelated Mastery product experiments, and general corporate materials are outside this repo and should not be mixed into the engineering handoff.

## Definition Of Done For Handoff

An engineer has enough access when they can:

1. Clone this repository.
2. Run it locally with a development environment file.
3. Access Render and view/deploy the service.
4. Access Twilio and inspect/configure the Mastery number/webhooks.
5. Access Linq and inspect/configure the iMessage number/webhook.
6. Access the OpenAI project used by the service.
7. Trigger a test text conversation.
8. Trigger a test phone call.
9. See logs for both.
10. Make and deploy a code change without using the founder's credentials.

That is the handoff target.