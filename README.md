# Events OS

A purpose-built "Events OS" that turns the Public Worship event playbook into
software — so any chapter lead, in any city, can spin up an event, run it, and
hand it off without relying on one person's memory.

Built on **Convex + Expo** via the [Supa framework](https://github.com/lilseyi/supa-framework)
(`@supa/*`). Standalone repo; the first real consumer of the framework.

## Stack
- Expo (mobile **and** web via Expo Router) + Convex backend
- Email-OTP auth (`@convex-dev/auth`), internal-only for v1
- Multi-tenant by **chapter** (modeled now; chapter cloning is V3)

## Develop
```bash
pnpm install        # requires GITHUB_TOKEN with read:packages for @supa/*
npx convex dev
pnpm dev
```

See the spec for the full product scope.
