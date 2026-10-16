#!/bin/sh
exec bun run "$(dirname "$(readlink -f "$0")")/generate-commit-message.ts" "$@"
