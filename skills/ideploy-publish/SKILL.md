---
name: ideploy-publish
description: Build, sign, publish, and deliver a registered-device iOS app through the iDeploy CLI and private TOS-backed server. Use when the user asks to install the current Xcode project or an existing IPA on their registered iPhone, publish a development build, verify the iDeploy pipeline, or generate an iDeploy device pairing code.
---

# Publish with iDeploy

Use `ideploy` as the only implementation. Do not reproduce Xcode, TOS, API, or signing logic in ad hoc scripts.

## Workflow

1. Read the repository's `AGENTS.md` and confirm the current directory contains the intended Xcode project or workspace.
2. Run `ideploy doctor --json`. Report failed checks without printing credentials.
3. For a current project, run `ideploy deploy --json`. Add `--dry-run` only when the user requests a preview and `--no-push` only when explicitly requested.
4. For an existing IPA, run `ideploy publish /absolute/path/to/App.ipa --json`.
5. Parse the JSON result and report the release ID, publish status, and queued push count. Never print bearer tokens or TOS signed URLs.

## Pair a device

Run `ideploy pair` to display the one-time QR code and manual code. Pairing requires a prior `ideploy login --token-stdin`; never request or echo the publisher token in chat.

## Failure handling

- If `doctor` reports no publisher token, tell the user to run `ideploy login --token-stdin` locally.
- If project discovery is ambiguous, use `.ideploy.toml` or explicit Xcode values rather than guessing a scheme.
- If signing fails, preserve the build log and check registered-device provisioning; do not switch to enterprise signing.
- If upload completes but publish completion fails, rerun the same command. The release request is SHA-256 idempotent.
