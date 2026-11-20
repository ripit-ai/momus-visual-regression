// tests/capture/route.test.ts
import { test, expect } from "bun:test";
import { hostBlocked } from "../../src/capture/route";

test("an exact entry blocks that host only", () => {
  expect(hostBlocked("cdn.example.com", ["cdn.example.com"])).toBe(true);
  expect(hostBlocked("www.cdn.example.com", ["cdn.example.com"])).toBe(false);
  expect(hostBlocked("example.com", ["cdn.example.com"])).toBe(false);
});

test("a *. entry blocks subdomains at any depth, not the bare domain", () => {
  expect(hostBlocked("na-data.kameleoon.eu", ["*.kameleoon.eu"])).toBe(true);
  expect(hostBlocked("a.b.kameleoon.eu", ["*.kameleoon.eu"])).toBe(true);
  expect(hostBlocked("kameleoon.eu", ["*.kameleoon.eu"])).toBe(false);
});

test("a *. entry doesn't match a domain that merely ends with the same letters", () => {
  expect(hostBlocked("notkameleoon.eu", ["*.kameleoon.eu"])).toBe(false);
});

test("nothing is blocked by an empty list", () => {
  expect(hostBlocked("cdn.example.com", [])).toBe(false);
});
