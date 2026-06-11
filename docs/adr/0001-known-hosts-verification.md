# ADR 0001: SSH Host Key Verification via Known Hosts

## Status

Accepted

## Context

Prior to v1.0.0, all SSH connections used `ssh.InsecureIgnoreHostKey()` as the `HostKeyCallback`. This means SilkSpool never verified the identity of remote hosts, making it vulnerable to man-in-the-middle (MITM) attacks. An attacker controlling the network path between the control node and a managed host could intercept SSH connections, steal credentials, and inject commands — a critical risk for an infrastructure orchestration tool that executes remote commands with full host access.

## Decision

Replace `InsecureIgnoreHostKey()` with host key verification using a `known_hosts` file stored in BaseDir (`/opt/SilkSpool/known_hosts`). The `SSHClient` now accepts a `WithKnownHosts(path)` option that configures `knownhosts.New()` as the `HostKeyCallback`.

Host keys are trusted during `spool init <host>`, which:
1. Connects with `InsecureIgnoreHostKey` for the first contact
2. Retrieves the host's public key
3. Appends it to the `known_hosts` file
4. All subsequent connections use strict verification

If the `known_hosts` option is not provided (e.g., during key rotation fallback), the client falls back to `InsecureIgnoreHostKey` to maintain backward compatibility.

## Consequences

### Positive

- Runtime SSH connections are protected against MITM attacks
- Host identity changes (OS reinstall, IP reuse) are detected and flagged
- Aligns with SSH security best practices
- Known hosts file is managed alongside other SilkSpool assets (BaseDir)

### Negative

- First connection to a new host requires `spool init` — no ad-hoc SSH to unknown hosts
- Host key changes (legitimate or malicious) block all operations until `known_hosts` is updated
- No interactive prompt for host key trust (unlike OpenSSH's `Are you sure you want to continue connecting?`) — trust is explicit via `init`

### Mitigation

- `spool init` is already required for host setup (SSH key deployment, Docker group), so the known_hosts step fits naturally into the existing workflow
- Host key mismatches produce clear error messages guiding users to remove stale entries or re-run `init`
- The fallback path (`InsecureIgnoreHostKey` when `known_hosts` is unset) preserves functionality during emergency key rotation