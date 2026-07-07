"use client";

import { useParams } from "next/navigation";

import EntryFlow from "@/components/EntryFlow";

export default function SlugPreparePage() {
  const params = useParams<{ slug: string }>();
  return <EntryFlow initialStep="prepare" initialSlug={params.slug} />;
}
