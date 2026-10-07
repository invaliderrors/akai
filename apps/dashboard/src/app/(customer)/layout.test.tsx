import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A regression test for a real, user-reported bug: a PARTNER account that
 * signed in through the plain /sign-in form (no `?next=/partner` — e.g. a
 * bookmark, or the bare app.akai.shop entry point) landed on the CUSTOMER
 * account overview — "Hello, Mike / No orders yet" — instead of `/partner`,
 * the one page this feature promises them. `(admin)/layout.tsx` has no
 * dedicated test file (this codebase's usual convention leans on
 * `route-policy.test.ts` for access-level coverage), but THIS check lives
 * only in the layout itself, so it needs its own test to ever be pinned.
 */

const redirect = vi.fn((args: unknown) => {
  void args;
  throw new Error("NEXT_REDIRECT");
});
const getSession = vi.fn<() => Promise<unknown>>();

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()), redirect: (args: unknown) => redirect(args),
}));
vi.mock("@/lib/session/server", () => ({ getSession: () => getSession() }));
vi.mock("@/components/shell/dashboard-shell", () => ({
  DashboardShell: ({ children }: { children: unknown }) => children,
}));

const { default: CustomerLayout } = await import("./layout");

function session(overrides: Partial<{ role: string }> = {}) {
  return {
    email: "ana@example.com",
    role: overrides.role ?? "CUSTOMER",
    twoFactorEnabled: false,
  };
}

describe("CustomerLayout", () => {
  beforeEach(() => {
    redirect.mockClear();
    getSession.mockReset();
  });

  it("redirects a PARTNER session to /partner instead of rendering the customer shell", async () => {
    getSession.mockResolvedValue(session({ role: "PARTNER" }));

    await expect(CustomerLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledWith("/partner");
  });

  it("renders the customer shell for an ordinary CUSTOMER session", async () => {
    getSession.mockResolvedValue(session({ role: "CUSTOMER" }));

    const result = await CustomerLayout({ children: "content" });

    expect(redirect).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });

  it("still redirects to sign-in when there is no session at all", async () => {
    getSession.mockResolvedValue(null);

    await expect(CustomerLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledWith("/sign-in");
  });
});
