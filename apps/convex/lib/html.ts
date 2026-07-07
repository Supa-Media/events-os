/**
 * HTML escaping for server-rendered strings (emails, public pages).
 *
 * One implementation so every renderer escapes identically — landing pages,
 * ticket pages, reminder emails, and the project action page. Escapes the
 * five characters that can break out of element content or a double- or
 * single-quoted attribute.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
