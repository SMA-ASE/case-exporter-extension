# Salesforce Case Exporter — Project Status

Last updated: 2026-05-08

## Current State
- Build prompt finalized and uploaded as project-prompt.md
- No extension files written yet
- Claude Code session not yet started

## Key Decisions
- Edge extension chosen over Playwright/headless due to Okta SSO + MFA on 
  Salesforce org (no way to automate login)
- Auth mechanism: credentials: 'include' on fetch calls to leverage existing 
  session cookie — no Authorization headers
- Target case volume: 20-60 cases per export run, hard cap 100
- REST API version: v57.0 or higher
- Zip library: JSZip loaded dynamically from cdnjs in popup.js
- Pagination: warn user but do not attempt auto-scroll or auto-paginate
- View support: List (primary), Split, Kanban (all three with separate selector 
  strategies)
- Output directory: C:\Users\BlakeLetzler\Downloads\case-exporter-extension\

## Immediate Next Action
Start a Claude Code session, paste project-prompt.md as the prompt, run with 
Sonnet, and verify all 6 files are written to the output directory.

## Files the Extension Will Produce
- manifest.json
- popup.html
- popup.js
- content.js
- background.js
- INSTALL.md

## Known Risks / Follow-Up Items
- Salesforce DOM selectors (data-record-id, href patterns) are based on 
  expected Lightning structure but untested against this specific org — may 
  need tuning after first test run
- Kanban selector strategy is least certain of the three views
- getApiBase() URL derivation assumes standard *.lightning.force.com domain 
  pattern — verify against actual org URL on first run
- API access via session cookie depends on org permissions — 403 handling is 
  built in but actual access not yet confirmed

## Open Questions
- Does the org use a custom Salesforce domain that differs from the standard 
  lightning.force.com pattern?
- Are there any org-level API access restrictions that would block 
  unauthenticated-header requests even with a valid session cookie?