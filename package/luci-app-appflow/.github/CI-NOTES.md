# CI notes

**The workflow files are the source of truth.** Every non-obvious decision is
commented at the line it affects, in `workflows/build.yml` and
`workflows/lint.yml`. This file records only what those files cannot say about
themselves. It was previously a summary of the workflows and drifted out of
date within days of being written, which is the reason it no longer summarises
them.

## Status

Both workflows run on every push and pull request to `main`, and both are
green, producing installable packages for two architectures.

## Why these two architectures

`arm_cortex-a15_neon-vfpv4` is the development and test device (Linksys
EA8500, ipq806x). `aarch64_cortex-a53` is a common current target class and
catches anything accidentally 32-bit specific. The packages are
`LUCI_PKGARCH:=all`, so this matrix exercises the build and packaging path
rather than producing genuinely different binaries.

## What CI does and does not cover

Covered: the package builds from a clean OpenWrt SDK for both architectures and
produces both named packages; the init script passes shellcheck against the
busybox dialect; the ucode daemon compiles; the LuCI view JS passes ESLint; all
JSON parses.

**Not covered, and not coverable here:** anything requiring the daemon to run
against a live netifyd, and anything requiring real network hardware. The two
known gaps of that kind (NAT dual-capture attribution and a live WAN failover
under load) are documented in `docs/DESIGN.md` section 8 and in the README. A
green CI run says the package builds and its sources are well formed. It does
not say the DPI attribution is correct on your network.

## History worth keeping

The first execution of these workflows, on 2026-08-22, failed and kept failing
through six distinct defects: a floating `@eslint/js@latest` against a pinned
`eslint@9`; a missing `ecmaFeatures.globalReturn` that made ESLint reject every
LuCI view; a shellcheck glob matching nothing; SC2034 and SC3043 raised because
the wrong shell dialect was being checked; a feed layout that meant **neither
package built at all**; and the icons subpackage staged as a child rather than
a sibling. None of this was visible locally. The workflows had been written,
reviewed and reasoned about, but never run.
