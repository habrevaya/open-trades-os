import { describe, it, expect } from "vitest";
import { keptValues } from "../src/lib/kept-values";

describe("what a refused form hands back", () => {
  it("keeps the named fields and nothing else, so a password is never echoed", () => {
    const form = new FormData();
    form.set("email", "avery@northwind.example");
    form.set("password", "correct horse battery staple");
    form.set("name", "");
    expect(keptValues(form, ["email", "name"])).toEqual({ email: "avery@northwind.example" });
  });
});
