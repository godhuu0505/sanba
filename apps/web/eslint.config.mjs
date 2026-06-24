import next from "eslint-config-next";

const eslintConfig = [
  ...next,
  {
    // eslint-plugin-react の React バージョン自動検出を避けるため明示する（検出経路は
    // ESLint のバージョン差でクラッシュしやすい）。使用中の React に固定。
    settings: { react: { version: "19.2" } },
    rules: {
      // eslint-config-next@16 が有効化する eslint-plugin-react-hooks v6 の
      // 「React Compiler」系の実験的ルール群。本リポジトリはまだ Compiler を採用しておらず、
      // 既存の正当なパターンに誤検知する（例: ref 遅延初期化 storeRef.current ??= new Store()、
      // マウント時データ取得 useEffect(() => void load(), [load])）。安定版の
      // rules-of-hooks / exhaustive-deps は維持しつつ、実験的ルールのみ無効化する。
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    ignores: [".next/**", "node_modules/**"],
  },
];

export default eslintConfig;
