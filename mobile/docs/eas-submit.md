# EAS submit credentials — how to supply them WITHOUT committing files

MOB-5 (2026-11-09 P1 wave). The `submit.production` profile in
[`../eas.json`](../eas.json) intentionally contains **no credentials**.
It previously carried placeholder values that hard-blocked store
distribution:

- Android: a `serviceAccountKeyPath` pointing at a nonexistent local file
  outside the project — every production submission failed before uploading.
- iOS: placeholder `appleId` / `ascAppId` / `appleTeamId` values (fake email
  and dummy IDs) — submissions could never authenticate.

Only real, non-secret config remains (`track: "internal"` for Android).
`eas.json` / `app.json` are strict JSON (they are validated with
`JSON.parse` in CI), so this file — not comments — is where the operator
instructions live.

## Rule

Never commit key files or account credentials to this repo. Supply them at
submit time through the CLI's remote credentials or environment variables.
When in doubt about the canonical, current env-var names, check the official
EAS Submit "Automation"/CI documentation — the names below are the commonly
documented ones.

## Android (Google Play service account key)

Preferred — remote credentials, nothing touches the repo:

```sh
cd mobile && npx eas submit --platform android --profile production
```

The CLI prompts for the service account key once and stores it with your EAS
project (remote credentials); subsequent submissions reuse it.

CI / non-interactive — env var pointing at a key file kept OUTSIDE the repo
(download it into the job's ephemeral storage from your CI secret store):

```sh
export SERVICE_ACCOUNT_KEY_PATH=/secrets/play-service-account.json   # CI secret, never committed
npx eas submit --platform android --profile production --latest
```

## iOS (App Store Connect)

Preferred — remote credentials:

```sh
cd mobile && npx eas submit --platform ios --profile production
```

Apple-specific credentials (Apple ID + app-specific password, or an App Store
Connect API key) are set up once via `eas submit`'s interactive prompts /
`eas credentials` and stored remotely by EAS.

CI / non-interactive — export the documented Apple env vars as CI secrets,
e.g. the `APPLE_ID` (+ app-specific password) family or the `ASC_API_KEY_*`
API-key family, plus the store app id (`ASC_APP_ID`) if it is not resolved
interactively. Exact names per platform: see the EAS Submit docs.

## EAS secrets vs. submit credentials

`eas secret:create --scope project …` injects values into **EAS Build**
environments (build-time env, e.g. `EXPO_PUBLIC_*` variables). That is the
right tool for build-time configuration; submit credentials belong to the
CLI/CI environment as described above. (Build-time secrets like
`EXPO_PUBLIC_TLS_PINS` — see `src/lib/api.ts` MOB-2 — DO belong in EAS
secrets / build-profile env.)
