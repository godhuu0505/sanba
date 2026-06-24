// Tailwind v4 は PostCSS プラグインとして動く (CSS-first / ADR-0014 §12)。
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
