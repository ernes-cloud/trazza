# Security Policy

## Supported versions

| Version / channel | Supported |
|-------------------|-----------|
| Latest commit on the OSS default branch | Yes |
| Older tags or forks | Best effort only |

We do not provide security fixes for the private Trazza SaaS deployment; this policy applies to the open-source repository only.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public GitHub issue for exploitable bugs.

- Email: **security@example.com** (placeholder — replace with your security contact before public launch)
- Include: affected component, reproduction steps, impact, and any suggested fix.

We aim to acknowledge reports within **5 business days** and to ship fixes or mitigations as soon as practicable.

## Hard secrets

Never commit `.env`, `server/.env`, API keys, JWTs, or production URLs. Use `.env.example` as the reference list of variables.
