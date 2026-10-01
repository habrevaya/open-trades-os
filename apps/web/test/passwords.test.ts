import { describe, it, expect, vi } from "vitest";

// The module is server only, and this is the server.
vi.mock("server-only", () => ({}));

const { hashPassword, verifyPassword } = await import("@/lib/session");

/**
 * Signing up and signing in both hash a password, and at the parameters this
 * product uses Node's default scrypt memory ceiling refused the call. Every
 * signup and every password sign in failed with a server error. These run
 * the real parameters, not cheaper ones, because the cheaper ones pass.
 */
describe("passwords", () => {
  it("hashes at the parameters it records, and verifies what it hashed", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stapler", stored)).toBe(false);
  });

  it("verifies against the dummy hash an unknown email is checked against, without throwing", async () => {
    await expect(verifyPassword("anything", "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA")).resolves.toBe(false);
  });
});
