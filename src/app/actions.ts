"use server";

import { revalidateTag } from "next/cache";

import { GITHUB_TAG } from "@/lib/github/data";

/**
 * Drop cached inbox & rate-limit data so the next render refetches. Read-only: never writes to GitHub.
 * Deliberately leaves the security scan cache alone — it's expensive (fans out per repo) and
 * revalidates on its own slower schedule instead.
 */
export async function refresh() {
  // `{ expire: 0 }`: the next render refetches instead of serving stale data. (`updateTag` only
  // covers `use cache`/fetch tags, not `unstable_cache`.)
  revalidateTag(GITHUB_TAG, { expire: 0 });
}
