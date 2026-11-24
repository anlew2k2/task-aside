#!/usr/bin/env bash
set -euo pipefail

BRANCH="${BRANCH:-main}"
BUMP="${BUMP:-}"
DRY_RUN="${DRY_RUN:-1}"
LIVE_TEST="${LIVE_TEST:-0}"
SKIP_GH_RELEASE="${SKIP_GH_RELEASE:-0}"
SKIP_VERIFY="${SKIP_VERIFY:-0}"
ALLOW_BRANCH="${ALLOW_BRANCH:-0}"
NPM_TAG="${NPM_TAG:-}"
NPM_OTP="${NPM_OTP:-}"

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

read_pkg_field() {
  node --input-type=module -e '
    import fs from "node:fs";
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const field = process.argv[1];
    process.stdout.write(String(pkg[field] ?? ""));
  ' "$1"
}

# Step 1: Preflight checks
log "==> [1/4] Preflight checks"
require_cmd git
require_cmd node
require_cmd npm
if [ "${SKIP_GH_RELEASE}" != "1" ]; then
  require_cmd gh
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "${ALLOW_BRANCH}" != "1" ] && [ "${current_branch}" != "${BRANCH}" ]; then
  die "Current branch is '${current_branch}', expected '${BRANCH}' (set ALLOW_BRANCH=1 to override)."
fi

dirty_status="$(git status --porcelain)"
if [ -n "${dirty_status}" ]; then
  if [ "${DRY_RUN}" = "1" ]; then
    warn "Working tree is not clean (allowed in DRY_RUN=1):"
    printf '%s\n' "${dirty_status}" >&2
  else
    die "Working tree is not clean. Commit or stash your changes before releasing."
  fi
fi

pkg_name="$(read_pkg_field name)"
current_version="$(read_pkg_field version)"
[ -n "${pkg_name}" ] || die "Could not read package name from package.json"
[ -n "${current_version}" ] || die "Could not read package version from package.json"
log "Package: ${pkg_name}@${current_version} (branch: ${current_branch})"

current_tag="v${current_version}"
remote_tag_ref=""

if [ "${DRY_RUN}" = "1" ]; then
  remote_tag_ref="$(git ls-remote --tags origin "refs/tags/${current_tag}" 2>/dev/null || true)"
else
  git fetch origin "${BRANCH}" --tags
  behind_count="$(git rev-list --count "HEAD..origin/${BRANCH}")"
  if [ "${behind_count}" -gt 0 ]; then
    die "Local branch '${current_branch}' is behind origin/${BRANCH} by ${behind_count} commit(s). Pull/rebase before releasing."
  fi
  remote_tag_ref="$(git ls-remote --tags origin "refs/tags/${current_tag}" 2>/dev/null || true)"
fi

if [ "${DRY_RUN}" = "1" ]; then
  if npm_user="$(npm whoami 2>/dev/null)"; then
    log "npm auth: ${npm_user}"
  else
    warn "Not logged in to npm (npm whoami failed). Real release will run 'npm login'."
  fi
else
  npm whoami >/dev/null 2>&1 || npm login
fi

if [ "${SKIP_GH_RELEASE}" != "1" ]; then
  if [ "${DRY_RUN}" = "1" ]; then
    if ! gh auth status >/dev/null 2>&1; then
      warn "gh is not authenticated. Run 'gh auth login' or set SKIP_GH_RELEASE=1 for real release."
    fi
  else
    gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run 'gh auth login' or set SKIP_GH_RELEASE=1."
  fi
fi

# Step 2: Tests & package inspection
log "==> [2/4] Running tests and inspecting package tarball"
npm test
if [ "${LIVE_TEST}" = "1" ]; then
  npm run test:live
fi
npm pack --dry-run

# Step 3: Resolve version & tag strategy
log "==> [3/4] Resolving version and tag strategy"
tag_exists=0
if git rev-parse -q --verify "refs/tags/${current_tag}" >/dev/null 2>&1 || [ -n "${remote_tag_ref}" ]; then
  tag_exists=1
fi

mode=""
bump_arg=""
target_version=""

if [ -z "${BUMP}" ]; then
  if [ "${tag_exists}" -eq 0 ]; then
    mode="tag-current"
    target_version="${current_version}"
  else
    mode="npm-version"
    bump_arg="patch"
  fi
elif [ "${BUMP}" = "current" ] || [ "${BUMP}" = "none" ]; then
  if [ "${tag_exists}" -eq 1 ]; then
    die "Tag '${current_tag}' already exists, so BUMP=${BUMP} cannot be used. Bump the version instead."
  fi
  mode="tag-current"
  target_version="${current_version}"
else
  mode="npm-version"
  bump_arg="${BUMP}"
fi

if [ "${mode}" = "tag-current" ]; then
  if npm view "${pkg_name}@${target_version}" version >/dev/null 2>&1; then
    die "${pkg_name}@${target_version} is already published on npm."
  fi
  log "Strategy: tag current version ${target_version} (${current_tag})"
else
  log "Strategy: bump version via 'npm version ${bump_arg}'"
fi

# Step 4: Version/tag, publish, push, GitHub Release, verify
publish_args=(publish)
case "${pkg_name}" in
  @*)
    publish_args+=(--access public)
    ;;
esac
if [ -n "${NPM_TAG}" ]; then
  publish_args+=(--tag "${NPM_TAG}")
fi
if [ -n "${NPM_OTP}" ]; then
  publish_args+=(--otp "${NPM_OTP}")
fi

if [ "${DRY_RUN}" = "1" ]; then
  log "==> [4/4] DRY_RUN=1 — planned release commands:"
  if [ "${mode}" = "tag-current" ]; then
    planned_tag="v${target_version}"
    planned_ver="${target_version}"
    log "  git tag -a \"${planned_tag}\" -m \"${planned_tag}\""
  else
    planned_tag="v<new-version>"
    planned_ver="<new-version>"
    log "  npm version \"${bump_arg}\""
  fi
  log "  npm ${publish_args[*]}"
  log "  git push origin \"${BRANCH}\" \"${planned_tag}\""
  if [ "${SKIP_GH_RELEASE}" != "1" ]; then
    log "  gh release create \"${planned_tag}\" --generate-notes"
  fi
  if [ "${SKIP_VERIFY}" != "1" ]; then
    log "  npx --yes \"${pkg_name}@${planned_ver}\" --version"
    if command -v bunx >/dev/null 2>&1; then
      log "  bunx --bun \"${pkg_name}@${planned_ver}\" --version"
    fi
  fi
  exit 0
fi

log "==> [4/4] Publishing release"
if [ "${mode}" = "tag-current" ]; then
  git tag -a "v${current_version}" -m "v${current_version}"
else
  npm version "${bump_arg}"
fi

final_version="$(read_pkg_field version)"
final_tag="v${final_version}"

npm "${publish_args[@]}"
git push origin "${BRANCH}" "${final_tag}"

if [ "${SKIP_GH_RELEASE}" != "1" ]; then
  gh release create "${final_tag}" --generate-notes
fi

if [ "${SKIP_VERIFY}" != "1" ]; then
  log "==> Verifying published package ${pkg_name}@${final_version}"
  verified=0
  attempt=1
  while [ "${attempt}" -le 3 ]; do
    if npx_ver="$(npx --yes "${pkg_name}@${final_version}" --version 2>/dev/null)"; then
      log "npx verification succeeded: ${npx_ver}"
      if command -v bunx >/dev/null 2>&1; then
        if bunx_ver="$(bunx --bun "${pkg_name}@${final_version}" --version 2>/dev/null)"; then
          log "bunx verification succeeded: ${bunx_ver}"
          verified=1
          break
        fi
      else
        verified=1
        break
      fi
    fi
    if [ "${attempt}" -lt 3 ]; then
      log "Registry propagation pending (attempt ${attempt}/3); retrying in 3s..."
      sleep 3
    fi
    attempt=$((attempt + 1))
  done

  if [ "${verified}" -ne 1 ]; then
    warn "Package was published, but post-publish verification did not succeed after 3 attempts (registry propagation may still be catching up)."
    warn "Run manually to verify:"
    warn "  npx --yes \"${pkg_name}@${final_version}\" --version"
    if command -v bunx >/dev/null 2>&1; then
      warn "  bunx --bun \"${pkg_name}@${final_version}\" --version"
    fi
  fi
fi

log "Release ${pkg_name}@${final_version} (${final_tag}) complete."
