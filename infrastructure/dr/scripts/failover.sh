#!/usr/bin/env bash
# Fail the service over to another region and move Cloudflare traffic (#959).
#
# Usage:
#   failover.sh --to REGION [--from REGION] [--origin URL] [--bucket BUCKET]
#               [--skip-traffic] [--yes]
#
#   --to            Region to fail over to (normally the secondary).
#   --from          Region being abandoned; scaled to 0 first if reachable.
#   --origin        Public origin URL of the target region
#                   (default: $DR_ORIGIN_<REGION>). Required to switch traffic.
#   --bucket        Backup bucket (default: the DR bucket in --to).
#   --skip-traffic  Restore and scale only; leave Cloudflare untouched.
#   --yes           Do not ask for confirmation.
#
# Needs aws, curl and npx (wrangler); CLOUDFLARE_API_TOKEN must be set to
# switch traffic. Nothing here depends on Terraform, so it works while the
# primary region's state backend is down.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

TO=""
FROM=""
ORIGIN=""
BUCKET=""
SWITCH=1
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --to) TO="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --origin) ORIGIN="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --skip-traffic) SWITCH=0; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ -n "$TO" ]] || fail "--to is required"
if [[ -z "$FROM" ]]; then
  [[ "$TO" == "$PRIMARY_REGION" ]] && FROM="$SECONDARY_REGION" || FROM="$PRIMARY_REGION"
fi
ORIGIN_VAR="DR_ORIGIN_$(echo "$TO" | tr 'a-z-' 'A-Z_')"
ORIGIN="${ORIGIN:-${!ORIGIN_VAR:-}}"
[[ "$SWITCH" -eq 0 || -n "$ORIGIN" ]] || fail "--origin (or $ORIGIN_VAR) is required to switch traffic"
require aws curl

if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "Fail over $DR_ENV from $FROM to $TO? Type the target region to confirm: " answer
  [[ "$answer" == "$TO" ]] || fail "confirmation did not match; aborting"
fi

STARTED="$(date +%s)"
notify "FAILOVER started: $FROM -> $TO"

# 1. Freeze the old region if we can still reach it. A region that is down
#    will simply time out here, which is fine.
log "step 1/4: freezing $FROM"
if timeout 60 aws ecs describe-clusters --region "$FROM" --clusters "$(ecs_name_for "$FROM")" >/dev/null 2>&1; then
  scale_service "$FROM" 0 || log "WARN: could not scale down $FROM; continuing"
else
  log "WARN: $FROM unreachable; assuming it is not serving writes"
fi

# 2-3. Restore data and bring the target up.
log "step 2-3/4: restoring and scaling $TO"
RECOVER_ARGS=(--region "$TO")
[[ -n "$BUCKET" ]] && RECOVER_ARGS+=(--bucket "$BUCKET")
[[ -n "$ORIGIN" ]] && RECOVER_ARGS+=(--origin "$ORIGIN")
SUMMARY="$("$(dirname "$0")/recover.sh" "${RECOVER_ARGS[@]}")" || fail "recovery in $TO failed"
log "recovery summary: $SUMMARY"

# 4. Move traffic.
if [[ "$SWITCH" -eq 1 ]]; then
  require npx
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || fail "CLOUDFLARE_API_TOKEN is not set"
  log "step 4/4: pointing Cloudflare STABLE_ORIGIN at $ORIGIN"
  (
    cd "$REPO_ROOT/infra/cloudflare"
    printf '%s' "$ORIGIN" | npx --yes wrangler secret put STABLE_ORIGIN
    npx --yes wrangler deploy --var CANARY_ENABLED:false
  ) || fail "Cloudflare origin switch failed; traffic still points at $FROM"
else
  log "step 4/4: skipped (--skip-traffic)"
fi

DURATION=$(( $(date +%s) - STARTED ))
notify "FAILOVER complete: now serving from $TO (${DURATION}s)"
printf '{"from":"%s","to":"%s","duration_seconds":%d,"recovery":%s}\n' "$FROM" "$TO" "$DURATION" "$SUMMARY"
