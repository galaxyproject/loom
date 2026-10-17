import { describe, expect, it } from "vitest";
import { GTN_BASE, gtnPageText, gtnTopics, gtnTutorials, gtnUrl } from "../shared/gtn.js";

// Both shells read GTN through shared/gtn.js; the browser's gtn.test.ts drives the tools end
// to end, this pins the shared pieces where Orbit's extension reaches them.
describe("shared/gtn", () => {
  it("reduces a page to its most specific region and drops the chrome", () => {
    const page = `<html><head><script>alert(1)</script></head><body><nav>Skip</nav>
<main>
<h1>RNA-Seq</h1>
<p>Run <code>fastp</code> &amp; then HISAT2.</p>
</main><footer>x</footer></body></html>`;
    expect(gtnPageText(page)).toBe("RNA-Seq\nRun fastp & then HISAT2.");
  });

  it("does not leak an unterminated script body", () => {
    expect(gtnPageText("<main>safe</main><script>secret(")).toBe("safe");
  });

  it("lists tutorials with absolute urls and filters on title or objectives", () => {
    const topic = {
      title: "Transcriptomics",
      materials: [
        {
          title: "Reference-based RNA-Seq",
          url: "/topics/t/ref/tutorial.html",
          tutorial_name: "ref",
        },
        {
          title: "Slides",
          url: "/topics/t/intro/slides.html",
          objectives: ["Call differential expression"],
        },
      ],
    };
    const all = gtnTutorials(topic)!;
    expect(all.count).toBe(2);
    expect(all.tutorials[0]!.url).toBe(`${GTN_BASE}/topics/t/ref/tutorial.html`);
    expect(all.tutorials[0]!.id).toBe("ref");
    expect(gtnTutorials(topic, "differential")!.tutorials.map((t) => t.title)).toEqual(["Slides"]);
    expect(gtnTutorials("404 page")).toBeUndefined();
    expect(gtnTopics({ a: { name: "a", title: "A" } })!.topics[0]).toEqual({
      name: "a",
      title: "A",
      summary: null,
    });
  });

  it("follows only http(s) urls on the GTN host", () => {
    expect(gtnUrl("https://training.galaxyproject.org/topics/x.html").problem).toBeUndefined();
    expect(gtnUrl("https://training.galaxyproject.org@evil.example/x").problem).toContain(
      "evil.example",
    );
    expect(gtnUrl("ftp://training.galaxyproject.org/x").problem).toBeDefined();
    expect(gtnUrl("not a url").problem).toContain("not a url");
  });
});
