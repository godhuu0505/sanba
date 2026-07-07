import next from "eslint-config-next";
import * as espree from "espree";

const eslintConfig = [
  ...next,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { parser: espree },
  },
  {
    settings: { react: { version: "19.2" } },
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    ignores: [".next/**", "node_modules/**"],
  },
];

export default eslintConfig;
