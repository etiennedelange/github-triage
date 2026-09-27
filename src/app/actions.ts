"use server";

import { updateTag } from "next/cache";

import { GITHUB_TAG } from "@/lib/github/data";

/** Drop cached GitHub data so the next render refetches. Read-only: never writes to GitHub. */
export async function refresh() {
  updateTag(GITHUB_TAG);
}
