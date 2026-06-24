import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// tsconfig の paths（@/* → ./*）を vitest にも反映する。
// 既存テストは相対 import なので無害、新規の @/components/sanba 等を解決するために必要。
export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
});
