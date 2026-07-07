"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function LegacyPrepareRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/");
  }, [router]);

  return null;
}
