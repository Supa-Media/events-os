// Minimal markdown helper for short YAML answer strings.
// Supports paragraph breaks (blank line), [text](url) links, **bold**,
// *italic*, and single-newline <br>. Not a general-purpose parser.

const escape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function renderMarkdown(input: string): string {
  return input
    .split(/\n\n+/)
    .map((paragraph) => {
      const inline = escape(paragraph)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
        .replace(
          /\[([^\]]+)\]\(([^)]+)\)/g,
          (_match, text: string, href: string) => {
            const isExternal = /^https?:/.test(href);
            const attrs = isExternal
              ? ' target="_blank" rel="noopener noreferrer"'
              : "";
            return `<a href="${href}"${attrs}>${text}</a>`;
          }
        )
        .replace(/\n/g, "<br />");
      return `<p>${inline}</p>`;
    })
    .join("");
}
