# SANBA タスクランナー — このファイルは `just` への薄い互換シムです。
# タスク定義の単一の正は justfile（https://github.com/casey/just）。
# `just` 未導入の環境でも `make <target>` で同じレシピを実行できるよう、
# 必要なら uv で just をローカルへ用意してから委譲します（レシピの重複を持ちません）。
#
#   make setup   # 初回ローカル環境構築 (= just setup)
#   make init    # 構築〜起動まで一気通貫 (= just init)
#   make up      # アプリ最小構成を起動 (= just up)
#   make         # ヘルプ (just --list)
.DEFAULT_GOAL := help

# uv tool install rust-just の配置先 (~/.local/bin) を PATH に含めて just を解決する。
export PATH := $(HOME)/.local/bin:$(PATH)

.PHONY: ensure-just help

# just が無ければ uv 経由で用意する（.claude/hooks/session-start.sh と同じ方式）。
ensure-just:
	@command -v just >/dev/null 2>&1 || { \
	  command -v uv >/dev/null 2>&1 || { echo "just も uv も見つかりません。https://just.systems からインストールしてください。"; exit 1; }; \
	  echo ">> just をインストールします (uv tool install rust-just)"; \
	  uv tool install rust-just; \
	}

help: ensure-just
	@just --list

# 既知・未知を問わず、全ターゲットを just に委譲する（justfile が単一の正）。
%: ensure-just
	@just $@

# catch-all (`%`) ルールが Makefile 自身を作り直そうとするのを防ぐ。
Makefile: ;
