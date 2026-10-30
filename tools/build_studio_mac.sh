#!/usr/bin/env bash
# build_studio_mac.sh - 打包 Neo Studio 桌面端 macOS remote-only app
# 用法: bash tools/build_studio_mac.sh
# 可选: PYTHON_BIN=tmp/.venv-mac/bin/python bash tools/build_studio_mac.sh
# 产物: build/dist-mac/Neo-Studio.app, tools/Neo-Studio.app
# macOS v1 只打包远程模式；本机 ComfyUI root / python 与 Windows WebView2/Job Object 路径不在这条包目标里。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

PYTHON_BIN="${PYTHON_BIN:-tmp/.venv-mac/bin/python}"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="${PYTHON:-python}"
fi

if ! "$PYTHON_BIN" -m PyInstaller --version >/dev/null 2>&1; then
  echo "缺少 PyInstaller。先安装构建依赖：$PYTHON_BIN -m pip install pyinstaller" >&2
  exit 1
fi

BUILD_DIR="build/pyi-mac"
DIST_DIR="build/dist-mac"
APP_NAME="Neo-Studio"
BUNDLE="$DIST_DIR/$APP_NAME.app"
TOOLS_BUNDLE="tools/Neo-Studio.app"

rm -rf "$BUILD_DIR" "$DIST_DIR"

"$PYTHON_BIN" -m PyInstaller \
  --clean --noconfirm \
  --workpath "$BUILD_DIR" \
  --distpath "$DIST_DIR" \
  --name "$APP_NAME" \
  --windowed --noconsole \
  --paths app \
  --osx-bundle-identifier ai.neoneo.studio \
  --hidden-import studio_server \
  --hidden-import studio_caps \
  --hidden-import mcp_client \
  --hidden-import mcp_routes \
  --collect-all webview \
  --collect-all aiohttp \
  --exclude-module pythonnet \
  --exclude-module tkinter \
  app/studio_app.py

if [[ -d "$BUNDLE" ]]; then
  rm -rf "$TOOLS_BUNDLE"
  cp -R "$BUNDLE" "$TOOLS_BUNDLE"
  echo "[DONE] $TOOLS_BUNDLE"
  echo "启动: open \"$TOOLS_BUNDLE\" --args --remote http://<远端主机>:<端口>"
else
  echo "[WARN] PyInstaller 没生成 .app；见 $DIST_DIR"
fi
