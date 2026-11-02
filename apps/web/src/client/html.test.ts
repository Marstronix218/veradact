import { describe, expect, it } from "vitest";
import { escapeHtml, html, isSafeHtml, unsafeRaw } from "./html";

describe("html tagged template", () => {
  it("escapes every interpolated string", () => {
    const evil = `<script>alert("x")</script>&'\``;
    expect(html`<p>${evil}</p>`.value).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;&#96;</p>");
  });

  it("escapes quotes so attribute values cannot break out", () => {
    const value = `" onfocus="alert(1)`;
    expect(html`<input value="${value}">`.value).toBe(`<input value="&quot; onfocus=&quot;alert(1)">`);
    expect(html`<input value='${"' autofocus x='"}'>`.value).toBe(`<input value='&#39; autofocus x=&#39;'>`);
  });

  it("does not double-escape nested templates and renders arrays element by element", () => {
    const items = ["a<b", "c&d"].map((t) => html`<li>${t}</li>`);
    expect(html`<ul>${items}</ul>`.value).toBe("<ul><li>a&lt;b</li><li>c&amp;d</li></ul>");
    expect(html`${[["<", html`<b>ok</b>`]]}`.value).toBe("&lt;<b>ok</b>");
  });

  it("renders nothing for null, undefined and false; numbers as is; objects escaped via String()", () => {
    expect(html`[${null}${undefined}${false}${0}${42}${10n}]`.value).toBe("[04210]");
    expect(html`${true}`.value).toBe("true");
    expect(html`${{ toString: () => "<x>" }}`.value).toBe("&lt;x&gt;");
  });

  it("only SafeHtml values bypass escaping; a look-alike object does not", () => {
    expect(isSafeHtml(html`x`)).toBe(true);
    expect(isSafeHtml({ value: "<b>" })).toBe(false);
    expect(html`${{ value: "<b>" }}`.value).toBe("[object Object]");
    expect(html`${unsafeRaw("<hr>")}`.value).toBe("<hr>");
    expect(String(html`<i>${"&"}</i>`)).toBe("<i>&amp;</i>");
  });

  it("escapeHtml handles every special character", () => {
    expect(escapeHtml(`&<>"'\``)).toBe("&amp;&lt;&gt;&quot;&#39;&#96;");
    expect(escapeHtml("plain text")).toBe("plain text");
  });
});
