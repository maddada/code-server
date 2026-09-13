#!/usr/bin/env bash
set -euo pipefail

# Builds vscode into lib/vscode/out-vscode.

# MINIFY controls whether a minified version of vscode is built.
MINIFY=${MINIFY-true}
CODE_SERVER_BUILD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GHOSTEX_REH_RIPGREP_PATCH="$CODE_SERVER_BUILD_ROOT/patches/reh-ripgrep-bin.diff"

fix-bin-script() {
  local script="lib/vscode-reh-web-$VSCODE_TARGET/bin/$1"
  sed -i.bak "s/@@VERSION@@/$(vscode_version)/g" "$script"
  sed -i.bak "s/@@COMMIT@@/$BUILD_SOURCEVERSION/g" "$script"
  sed -i.bak "s/@@APPNAME@@/code-server/g" "$script"

  # Fix Node path on Darwin and Linux.
  # We do not want expansion here; this text should make it to the file as-is.
  # shellcheck disable=SC2016
  sed -i.bak 's/^ROOT=\(.*\)$/VSROOT=\1\nROOT="$(dirname "$(dirname "$VSROOT")")"/g' "$script"
  sed -i.bak 's/ROOT\/out/VSROOT\/out/g' "$script"
  # We do not want expansion here; this text should make it to the file as-is.
  # shellcheck disable=SC2016
  sed -i.bak 's/$ROOT\/node/${NODE_EXEC_PATH:-$ROOT\/lib\/node}/g' "$script"

  # Fix Node path on Windows.
  sed -i.bak 's/^set ROOT_DIR=\(.*\)$/set ROOT_DIR=%~dp0..\\..\\..\\..\r\nset VSROOT_DIR=\1/g' "$script"
  sed -i.bak 's/%ROOT_DIR%\\out/%VSROOT_DIR%\\out/g' "$script"

  chmod +x "$script"
  rm "$script.bak"
}

copy-bin-script() {
  cp "lib/vscode/resources/server/bin/$1" "lib/vscode-reh-web-$VSCODE_TARGET/bin/$1"
  fix-bin-script "$1"
}

install-npm-tarball() {
  local package_spec="$1"
  local package_version="$2"
  local target_dir="$3"
  local package_name="$package_spec"
  local package_url="https://registry.npmjs.org/$package_name/-/$package_name-$package_version.tgz"
  local package_tmp_dir
  package_tmp_dir=$(mktemp -d)

  if [[ $package_spec == @*/* ]]; then
    local package_scope="${package_spec%%/*}"
    package_name="${package_spec#*/}"
    package_url="https://registry.npmjs.org/$package_scope/$package_name/-/$package_name-$package_version.tgz"
  fi

  echo "Installing $package_spec@$package_version for architecture-specific packaging..."
  if ! curl -fsSL "$package_url" |
    tar -xz --strip-components=1 -C "$package_tmp_dir"; then
    rm -rf "$package_tmp_dir"
    return 1
  fi

  rm -rf "$target_dir"
  mkdir -p "$(dirname "$target_dir")"
  mv "$package_tmp_dir" "$target_dir"
}

ensure-copilot-esbuild-platform() {
  local copilot_dir="extensions/copilot"
  local esbuild_package
  esbuild_package=$(node <<'NODE'
const packages = new Map([
  ['darwin-x64', '@esbuild/darwin-x64'],
  ['darwin-arm64', '@esbuild/darwin-arm64'],
  ['linux-x64', '@esbuild/linux-x64'],
  ['linux-arm64', '@esbuild/linux-arm64'],
  ['win32-x64', '@esbuild/win32-x64'],
  ['win32-arm64', '@esbuild/win32-arm64'],
]);
process.stdout.write(packages.get(`${process.platform}-${process.arch}`) ?? '');
NODE
)

  if [[ -z $esbuild_package ]]; then
    return
  fi

  if [[ -d "$copilot_dir/node_modules/$esbuild_package" ]]; then
    return
  fi

  local esbuild_version
  esbuild_version=$(node -p "require('./$copilot_dir/node_modules/esbuild/package.json').version")

  local esbuild_target_dir="$copilot_dir/node_modules/$esbuild_package"

  # CDXC:CodeServerRuntime 2026-06-08-14:42: Ghostex release builds package both macOS architectures on Apple Silicon. The Copilot extension build runs under the architecture-specific bundled Node, so ensure esbuild's native optional package matches that Node before packaging. Fetch the package directly because npm can hang when invoked under the translated x86_64 Node runtime during local release builds.
  install-npm-tarball "$esbuild_package" "$esbuild_version" "$esbuild_target_dir"
}

ensure-vscode-esbuild-platform() {
  local esbuild_package
  esbuild_package=$(node <<'NODE'
const packages = new Map([
  ['darwin-x64', '@esbuild/darwin-x64'],
  ['darwin-arm64', '@esbuild/darwin-arm64'],
  ['linux-x64', '@esbuild/linux-x64'],
  ['linux-arm64', '@esbuild/linux-arm64'],
  ['win32-x64', '@esbuild/win32-x64'],
  ['win32-arm64', '@esbuild/win32-arm64'],
]);
process.stdout.write(packages.get(`${process.platform}-${process.arch}`) ?? '');
NODE
)

  local esbuild_version
  esbuild_version=$(node -p "require('./build/package.json').devDependencies.esbuild")

  # CDXC:CodeServerRuntime 2026-06-08-14:57: VS Code core-ci bundles built-in extensions through the root esbuild dependency, which is absent after release dependency pruning. Install the root esbuild package and its active-architecture native optional package before extension bundling.
  if [[ ! -d node_modules/esbuild ]]; then
    install-npm-tarball "esbuild" "$esbuild_version" "node_modules/esbuild"
  fi

  if [[ -z $esbuild_package ]]; then
    return
  fi

  if [[ -d "node_modules/$esbuild_package" ]]; then
    return
  fi

  install-npm-tarball "$esbuild_package" "$esbuild_version" "node_modules/$esbuild_package"
}

ensure-typescript-native-platform() {
  local tsgo_package
  tsgo_package=$(node <<'NODE'
const packages = new Map([
  ['darwin-x64', '@typescript/typescript-darwin-x64'],
  ['darwin-arm64', '@typescript/typescript-darwin-arm64'],
  ['linux-x64', '@typescript/typescript-linux-x64'],
  ['linux-arm64', '@typescript/typescript-linux-arm64'],
  ['linux-arm', '@typescript/typescript-linux-arm'],
  ['win32-x64', '@typescript/typescript-win32-x64'],
  ['win32-arm64', '@typescript/typescript-win32-arm64'],
]);
process.stdout.write(packages.get(`${process.platform}-${process.arch}`) ?? '');
NODE
)

  if [[ -z $tsgo_package ]]; then
    return
  fi

  if [[ -d "node_modules/$tsgo_package" ]]; then
    return
  fi

  local tsgo_version
  tsgo_version=$(node -p "require('./node_modules/@typescript/native/package.json').version")

  # CDXC:CodeServerRuntime 2026-06-08-14:52: VS Code core-ci invokes tsgo under the architecture-specific bundled Node during Ghostex release packaging. Install the matching TypeScript 7 native package so cross-arch release builds do not depend on the host machine's arm64-only install tree.
  install-npm-tarball "$tsgo_package" "$tsgo_version" "node_modules/$tsgo_package"
}

vscode-ripgrep-node-arch() {
  case "$VSCODE_TARGET" in
    darwin-arm64)
      printf 'arm64\n'
      ;;
    darwin-x64)
      printf 'x64\n'
      ;;
    *)
      node -p 'process.arch'
      ;;
  esac
}

vscode-ripgrep-macho-arch() {
  case "$(vscode-ripgrep-node-arch)" in
    arm64)
      printf 'arm64\n'
      ;;
    x64)
      printf 'x86_64\n'
      ;;
  esac
}

ensure-vscode-ripgrep-platform() {
  local ripgrep_bin="node_modules/@vscode/ripgrep/bin/rg"
  local expected_arch
  expected_arch="$(vscode-ripgrep-macho-arch)"

  if [[ -f "$ripgrep_bin" ]] && /usr/bin/lipo -archs "$ripgrep_bin" 2>/dev/null | tr ' ' '\n' | grep -Fx "$expected_arch" >/dev/null; then
    return
  fi

  # CDXC:CodeServerRuntime 2026-06-09-17:06: Ghostex builds arm64 and x86_64 VS Code REH payloads on the same machine. Materialize @vscode/ripgrep for the target architecture before gulp copies it into the packaged runtime so file search never ships with a missing or opposite-arch rg binary.
  rm -rf node_modules/@vscode/ripgrep/bin
  env npm_config_arch="$(vscode-ripgrep-node-arch)" node node_modules/@vscode/ripgrep/lib/postinstall.js --force

  if [[ ! -f "$ripgrep_bin" ]] || ! /usr/bin/lipo -archs "$ripgrep_bin" 2>/dev/null | tr ' ' '\n' | grep -Fx "$expected_arch" >/dev/null; then
    echo "Expected @vscode/ripgrep to contain $expected_arch after postinstall: $ripgrep_bin" >&2
    exit 1
  fi
}

ensure-github-token-for-vscode-build() {
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    return
  fi
  if ! command -v gh >/dev/null 2>&1; then
    return
  fi

  local gh_token
  gh_token="$(gh auth token -h github.com 2>/dev/null || gh auth token 2>/dev/null || true)"
  if [[ -n "$gh_token" ]]; then
    # CDXC:CodeServerRuntime 2026-06-09-17:06: VS Code core-ci fetches built-in extension artifacts and @vscode/ripgrep releases from GitHub. Use the owner's authenticated gh token when no explicit GITHUB_TOKEN is present so local starts and releases do not fail from unauthenticated API rate limits while still avoiding logged secret material.
    export GITHUB_TOKEN="$gh_token"
  fi
}

ghostex_vscode_reh_ripgrep_patch_applied=0

apply-ghostex-vscode-build-patches() {
  # CDXC:CodeServerRuntime 2026-06-08-16:05: Ghostex's local release wrapper builds the nested VS Code checkout directly, so apply the tracked REH ripgrep packaging patch before gulp runs instead of relying on a developer's quilt-applied working tree.
  if patch --batch --dry-run -d "$CODE_SERVER_BUILD_ROOT" -N -p1 < "$GHOSTEX_REH_RIPGREP_PATCH" >/dev/null 2>&1; then
    patch --batch -d "$CODE_SERVER_BUILD_ROOT" -N -p1 < "$GHOSTEX_REH_RIPGREP_PATCH"
    ghostex_vscode_reh_ripgrep_patch_applied=1
    return
  fi

  if patch --batch --dry-run -d "$CODE_SERVER_BUILD_ROOT" -R -p1 < "$GHOSTEX_REH_RIPGREP_PATCH" >/dev/null 2>&1; then
    # CDXC:CodeServerRuntime 2026-06-09-17:06: A failed prior build can leave the temporary REH ripgrep patch applied before the cleanup trap is registered. Treat an already-applied patch as build-owned state so cleanup restores the nested VS Code checkout instead of failing the next app build.
    echo "Ghostex REH ripgrep patch is already applied; cleanup will restore it after packaging."
    ghostex_vscode_reh_ripgrep_patch_applied=1
    return
  fi

  patch --batch --dry-run -d "$CODE_SERVER_BUILD_ROOT" -N -p1 < "$GHOSTEX_REH_RIPGREP_PATCH"
}

cleanup-ghostex-vscode-build-edits() {
  if [[ $ghostex_vscode_reh_ripgrep_patch_applied == 1 ]]; then
    patch --batch -d "$CODE_SERVER_BUILD_ROOT" -R -p1 < "$GHOSTEX_REH_RIPGREP_PATCH" >/dev/null 2>&1 || true
  fi

  git -C "$CODE_SERVER_BUILD_ROOT/lib/vscode" checkout -- product.json >/dev/null 2>&1 || true
  rm -f "$CODE_SERVER_BUILD_ROOT/lib/vscode/product.original.json"
  rm -f "$CODE_SERVER_BUILD_ROOT/lib/vscode/build/gulpfile.reh.ts.rej"
}

main() {
  cd "$CODE_SERVER_BUILD_ROOT"

  source ./ci/lib.sh

  # Set the commit Code will embed into the product.json.  We need to do this
  # since Code tries to get the commit from the `.git` directory which will fail
  # as it is a submodule.
  #
  # Also, we use code-server's commit rather than VS Code's otherwise it would
  # not update when only our patch files change, and that will cause caching
  # issues where the browser keeps using outdated code.
  export BUILD_SOURCEVERSION
  BUILD_SOURCEVERSION=$(git rev-parse HEAD)
  ensure-github-token-for-vscode-build

  trap cleanup-ghostex-vscode-build-edits EXIT
  apply-ghostex-vscode-build-patches

  pushd lib/vscode

  if [[ ! ${VERSION-} ]]; then
    echo "VERSION not set. Please set before running this script:"
    echo "VERSION='0.0.0' npm run build:vscode"
    exit 1
  fi

  # Add the date, our name, links, enable telemetry (this just makes telemetry
  # available; telemetry can still be disabled by flag or setting), and
  # configure trusted extensions (since some, like github.copilot-chat, never
  # ask to be trusted and this is the only way to get auth working).
  #
  # This needs to be done before building as Code will read this file and embed
  # it into the client-side code.
  git checkout product.json             # Reset in case the script exited early.
  # CDXC:CodeServerRuntime 2026-06-08-12:17: Ghostex release builds invoke this code-server packaging path from the app build. Keep the nested VS Code checkout clean after successful builds by removing the temporary jq source copy that would otherwise leave code-server dirty before release commits.
  rm -f product.original.json
  cp product.json product.original.json # Since jq has no inline edit.
  jq --slurp '.[0] * .[1]' product.original.json <(
    cat << EOF
  {
    "enableTelemetry": true,
    "quality": "stable",
    "codeServerVersion": "$VERSION",
    "nameShort": "code-server",
    "nameLong": "code-server",
    "applicationName": "code-server",
    "dataFolderName": ".code-server",
    "win32MutexName": "codeserver",
    "licenseUrl": "https://github.com/coder/code-server/blob/main/LICENSE",
    "win32DirName": "code-server",
    "win32NameVersion": "code-server",
    "win32AppUserModelId": "coder.code-server",
    "win32ShellNameShort": "c&ode-server",
    "darwinBundleIdentifier": "com.coder.code.server",
    "linuxIconName": "com.coder.code.server",
    "reportIssueUrl": "https://github.com/coder/code-server/issues/new",
    "documentationUrl": "https://go.microsoft.com/fwlink/?LinkID=533484#vscode",
    "keyboardShortcutsUrlMac": "https://go.microsoft.com/fwlink/?linkid=832143",
    "keyboardShortcutsUrlLinux": "https://go.microsoft.com/fwlink/?linkid=832144",
    "keyboardShortcutsUrlWin": "https://go.microsoft.com/fwlink/?linkid=832145",
    "introductoryVideosUrl": "https://go.microsoft.com/fwlink/?linkid=832146",
    "tipsAndTricksUrl": "https://go.microsoft.com/fwlink/?linkid=852118",
    "newsletterSignupUrl": "https://www.research.net/r/vsc-newsletter",
    "linkProtectionTrustedDomains": [
      "https://open-vsx.org"
    ],
    "trustedExtensionAuthAccess": [
      "vscode.git", "vscode.github",
      "github.vscode-pull-request-github",
      "github.copilot", "github.copilot-chat"
    ],
    "aiConfig": {
      "ariaKey": "code-server"
    }
  }
EOF
  ) > product.json


  ensure-copilot-esbuild-platform
  VSCODE_QUALITY=stable npm run gulp compile-copilot-extension-full-build

  ensure-vscode-ripgrep-platform
  ensure-vscode-esbuild-platform
  ensure-typescript-native-platform
  npm run gulp core-ci
  npm run gulp "vscode-reh-web-$VSCODE_TARGET${MINIFY:+-min}-ci"

  # Reset so if you develop after building you will not be stuck with the wrong
  # commit (the dev client will use `oss-dev` but the dev server will still use
  # product.json which will have `stable-$commit`).
  git checkout product.json
  rm -f product.original.json

  popd

  pushd "lib/vscode-reh-web-$VSCODE_TARGET"
  # Make sure Code took the version we set in the environment variable.  Not
  # having a version will break display languages.
  if ! jq -e .commit product.json; then
    echo "'commit' is missing from product.json"
    exit 1
  fi
  popd

  # Set vars and fix paths.
  case $OS in
    windows)
      fix-bin-script remote-cli/code.cmd
      fix-bin-script helpers/browser.cmd
      ;;
    *)
      fix-bin-script remote-cli/code-server
      fix-bin-script helpers/browser.sh
      ;;
  esac

  # Include bin scripts for other platforms so we can use the right one in the
  # NPM post-install.

  # These provide a `code-server` command in the integrated terminal to open
  # files in the current instance.
  copy-bin-script remote-cli/code-darwin.sh
  copy-bin-script remote-cli/code-linux.sh
  copy-bin-script remote-cli/code.cmd

  # These provide a way for terminal applications to open browser windows.
  copy-bin-script helpers/browser-darwin.sh
  copy-bin-script helpers/browser-linux.sh
  copy-bin-script helpers/browser.cmd
}

main "$@"
