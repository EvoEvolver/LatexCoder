/**
 * Generate a version 4 UUID.
 *
 * `crypto.randomUUID()` only exists in secure contexts, so it is missing when a
 * self-hosted instance is reached over plain HTTP from another machine (browsers
 * treat `localhost` as secure, but not a LAN host or IP). Fall back to
 * `crypto.getRandomValues()`, which is available in every context, and finally
 * to `Math.random` for the rare environment without Web Crypto at all.
 */
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
