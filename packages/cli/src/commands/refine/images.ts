import type { LlmContentBlock } from "@slowcook-ai/core";

/**
 * Extract image URLs from an issue or comment body. GitHub renders both
 * HTML `<img src="...">` (its user-attachments format) and markdown
 * `![alt](url)` into images; we support both.
 *
 * Returns URLs in the order they appear. Deduplicates within the same
 * body — a screenshot referenced twice only counts once.
 */
export function extractImageUrls(body: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  // <img src="..."> (GitHub user-attachments — the common case for drag-drop
  // screenshots). Allow single or double quotes.
  const htmlRe = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = htmlRe.exec(body)) !== null) {
    const url = m[1];
    if (url && !seen.has(url)) {
      urls.push(url);
      seen.add(url);
    }
  }

  // ![alt](url) — markdown inline image. The url can be bare or wrapped
  // in <angle brackets>. Title suffix (" "tip"") is tolerated.
  const mdRe = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
  while ((m = mdRe.exec(body)) !== null) {
    const url = m[1];
    if (url && !seen.has(url)) {
      urls.push(url);
      seen.add(url);
    }
  }

  return urls;
}

const SUPPORTED_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * Fetch one image URL and return it as an LLM image content block, or
 * `null` if the fetch or decode fails. Never throws — we would rather
 * drop a screenshot than halt the whole refine run.
 */
export async function fetchImageAsBlock(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<LlmContentBlock | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (!contentType || !SUPPORTED_MEDIA_TYPES.has(contentType)) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: contentType as ImageMediaType,
        data: buffer.toString("base64"),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Turn a text body into a content array when it references image URLs
 * that resolve successfully. Returns the original string when there's
 * nothing to enrich — preserves the text-shorthand path for the common case.
 *
 * Images are appended AFTER the text block so the LLM reads the prose
 * first, then sees what it describes. The original `<img>` / markdown
 * references stay in the text so the agent can match text mentions to
 * the image it's looking at.
 */
export async function enrichBodyWithImages(
  body: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | LlmContentBlock[]> {
  const urls = extractImageUrls(body);
  if (urls.length === 0) return body;

  const blocks: LlmContentBlock[] = [{ type: "text", text: body }];
  for (const url of urls) {
    const block = await fetchImageAsBlock(url, fetchImpl);
    if (block) blocks.push(block);
  }

  // No image fetched successfully — fall back to plain text so we don't
  // wrap the body in a single-element array for no reason.
  if (blocks.length === 1) return body;

  return blocks;
}
