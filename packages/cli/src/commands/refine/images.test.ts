import { describe, it, expect } from "vitest";
import {
  extractImageUrls,
  fetchImageAsBlock,
  enrichBodyWithImages,
} from "./images.js";

describe("extractImageUrls", () => {
  it("finds <img src=\"...\"> URLs (GitHub user-attachments)", () => {
    const body = `
I see this error
<img width="968" height="532" alt="Image" src="https://github.com/user-attachments/assets/33631e4c" />
`;
    expect(extractImageUrls(body)).toEqual([
      "https://github.com/user-attachments/assets/33631e4c",
    ]);
  });

  it("finds ![alt](url) markdown images", () => {
    const body = `Here's the repro:\n\n![screenshot](https://example.com/pic.png)`;
    expect(extractImageUrls(body)).toEqual(["https://example.com/pic.png"]);
  });

  it("handles both html and markdown images in one body", () => {
    const body = `
<img src="https://a.png" />
and also
![cap](https://b.png)
`;
    expect(extractImageUrls(body)).toEqual([
      "https://a.png",
      "https://b.png",
    ]);
  });

  it("deduplicates repeated URLs", () => {
    const body = `<img src="https://x.png"/> see also <img src='https://x.png'/>`;
    expect(extractImageUrls(body)).toEqual(["https://x.png"]);
  });

  it("returns empty for bodies without images", () => {
    expect(extractImageUrls("just text here")).toEqual([]);
  });

  it("tolerates markdown images wrapped in angle brackets", () => {
    const body = `![img](<https://wrapped.png>)`;
    expect(extractImageUrls(body)).toEqual(["https://wrapped.png"]);
  });
});

function fakeFetch(
  responses: Map<string, { ok: boolean; contentType?: string; data?: Buffer }>
): typeof fetch {
  return (async (url: string) => {
    const r = responses.get(url);
    if (!r) return { ok: false, status: 404 } as unknown as Response;
    return {
      ok: r.ok,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "content-type" ? r.contentType ?? null : null,
      },
      arrayBuffer: async () =>
        (r.data ?? Buffer.alloc(0)).buffer.slice(
          (r.data ?? Buffer.alloc(0)).byteOffset,
          (r.data ?? Buffer.alloc(0)).byteOffset + (r.data ?? Buffer.alloc(0)).byteLength
        ),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("fetchImageAsBlock", () => {
  it("returns a base64 image block for a valid png response", async () => {
    const pixel = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = fakeFetch(
      new Map([
        ["https://x.png", { ok: true, contentType: "image/png", data: pixel }],
      ])
    );
    const block = await fetchImageAsBlock("https://x.png", fetchImpl);
    expect(block).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: pixel.toString("base64"),
      },
    });
  });

  it("returns null on non-ok response", async () => {
    const fetchImpl = fakeFetch(new Map([["https://x.png", { ok: false }]]));
    expect(await fetchImageAsBlock("https://x.png", fetchImpl)).toBeNull();
  });

  it("returns null for unsupported media types", async () => {
    const fetchImpl = fakeFetch(
      new Map([
        [
          "https://x.pdf",
          { ok: true, contentType: "application/pdf", data: Buffer.alloc(1) },
        ],
      ])
    );
    expect(await fetchImageAsBlock("https://x.pdf", fetchImpl)).toBeNull();
  });

  it("never throws — fetch rejection returns null", async () => {
    const explodey: typeof fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchImageAsBlock("https://x.png", explodey)).toBeNull();
  });

  it("tolerates content-type with a charset suffix", async () => {
    const pixel = Buffer.from([0x89, 0x50]);
    const fetchImpl = fakeFetch(
      new Map([
        [
          "https://x.png",
          { ok: true, contentType: "image/png; charset=binary", data: pixel },
        ],
      ])
    );
    const block = await fetchImageAsBlock("https://x.png", fetchImpl);
    expect(block?.type).toBe("image");
  });
});

describe("enrichBodyWithImages", () => {
  it("returns the body unchanged when there are no images", async () => {
    expect(await enrichBodyWithImages("plain text")).toBe("plain text");
  });

  it("returns a content array with text + image blocks when images resolve", async () => {
    const pixel = Buffer.from([1, 2, 3]);
    const fetchImpl = fakeFetch(
      new Map([
        [
          "https://github.com/user-attachments/assets/abc",
          { ok: true, contentType: "image/png", data: pixel },
        ],
      ])
    );
    const body = `I see this error\n<img src="https://github.com/user-attachments/assets/abc" />`;
    const result = await enrichBodyWithImages(body, fetchImpl);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: body });
    expect(result[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    });
  });

  it("falls back to plain text when every image fetch fails", async () => {
    const fetchImpl = fakeFetch(
      new Map([["https://broken.png", { ok: false }]])
    );
    const body = `oops <img src="https://broken.png"/>`;
    const result = await enrichBodyWithImages(body, fetchImpl);
    expect(result).toBe(body);
  });

  it("includes only the images that succeeded when some fail", async () => {
    const pixel = Buffer.from([9]);
    const fetchImpl = fakeFetch(
      new Map([
        ["https://good.png", { ok: true, contentType: "image/jpeg", data: pixel }],
        ["https://bad.png", { ok: false }],
      ])
    );
    const body = `<img src="https://good.png"/><img src="https://bad.png"/>`;
    const result = await enrichBodyWithImages(body, fetchImpl);
    if (!Array.isArray(result)) throw new Error("expected array");
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ source: { media_type: "image/jpeg" } });
  });
});
