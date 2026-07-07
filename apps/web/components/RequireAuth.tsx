"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { BrandSplash } from "@/components/sanba";

export interface RequireAuthProps {
  ready: boolean;
  loggedIn: boolean;
  next: string;
  children?: React.ReactNode;
}

type GateAuth = { devMode: boolean; ready: boolean; loggedIn: boolean };

export function authGate(auth: GateAuth, next: string): React.ReactElement | null {
  if (auth.devMode) return null;
  if (auth.ready && auth.loggedIn) return null;
  return <RequireAuth ready={auth.ready} loggedIn={auth.loggedIn} next={next} />;
}

export function RequireAuth({ ready, loggedIn, next, children }: RequireAuthProps) {
  const router = useRouter();

  useEffect(() => {
    if (ready && !loggedIn) {
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [ready, loggedIn, next, router]);

  if (!ready) return <BrandSplash />;
  if (!loggedIn) return null;
  return <>{children}</>;
}
