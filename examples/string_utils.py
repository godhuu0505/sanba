"""レビュー自動化フロー検証用のサンプル。

Codex レビュー → Claude 自動対応の一連を確認するための一時的なファイル。
あえて改善余地（型ヒント無し・非効率な文字列結合）を含めている。
"""


def join_names(names, sep=", "):
    result = ""
    for n in names:
        result = result + n + sep
    return result[: -len(sep)]
