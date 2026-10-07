import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { PageTemplate, type PageWidth } from "./page-template";

/**
 * `Link` is mocked down to the anchor it renders. The href it is GIVEN is what
 * matters here.
 */
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const WIDTH_TOKEN: Readonly<Record<PageWidth, string>> = {
  admin: "max-w-[var(--w-admin)]",
  reading: "max-w-[var(--w-reading)]",
  table: "max-w-[var(--w-table)]",
};

const WIDTHS: readonly PageWidth[] = ["admin", "reading", "table"];

describe("<PageTemplate />", () => {
  it("renders the title as the page's one and only level-1 heading", () => {
    render(
      <PageTemplate title="Pedidos" width="admin">
        contenido
      </PageTemplate>,
    );

    // getAllBy, not getBy: a second <h1> is exactly the regression this guards
    // — it is the defect the two page headers this replaces kept producing,
    // where a screen rendered its own title above the shared one.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Pedidos" })).toBeInTheDocument();
    expect(screen.getByText("contenido")).toBeInTheDocument();
  });

  it("renders the one-line description under the title", () => {
    render(
      <PageTemplate
        title="Pedidos"
        description="Todos los pedidos, con su estado de pago y envío."
        width="admin"
      >
        contenido
      </PageTemplate>,
    );

    expect(
      screen.getByText("Todos los pedidos, con su estado de pago y envío."),
    ).toBeInTheDocument();
  });

  it("renders no description paragraph when it has no description", () => {
    const { container } = render(
      <PageTemplate title="Pedidos" width="admin">
        contenido
      </PageTemplate>,
    );

    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("renders the actions slot", () => {
    render(
      <PageTemplate
        title="Pedidos"
        width="admin"
        actions={<button type="button">Exportar</button>}
      >
        contenido
      </PageTemplate>,
    );

    expect(screen.getByRole("button", { name: "Exportar" })).toBeInTheDocument();
  });

  it.each(WIDTHS)("gives the %s variant its own measure token", (width: PageWidth) => {
    const { container } = render(
      <PageTemplate title="Pedidos" width={width}>
        contenido
      </PageTemplate>,
    );

    const root = container.firstElementChild;
    expect(root?.className).toContain(WIDTH_TOKEN[width]);

    // The negative half matters more than the positive one: a copy-paste that
    // points two variants at the same token still passes a presence-only check.
    for (const other of WIDTHS.filter((candidate) => candidate !== width)) {
      expect(root?.className).not.toContain(WIDTH_TOKEN[other]);
    }
  });

  it("pays for the gutter and the vertical rhythm itself", () => {
    const { container } = render(
      <PageTemplate title="Pedidos" width="admin">
        contenido
      </PageTemplate>,
    );

    const root = container.firstElementChild;
    expect(root?.className).toContain("px-[var(--gutter)]");
    expect(root?.className).toContain("min-w-0");

    // Not a <main>: DashboardShell owns the single <main id="content"> the skip
    // link targets, and a second one would be invalid and would publish a
    // duplicate landmark.
    expect(container.querySelector("main")).toBeNull();
  });

  describe("title ramp", () => {
    it("takes the compact ramp from the admin width", () => {
      render(
        <PageTemplate title="Pedidos" width="admin">
          contenido
        </PageTemplate>,
      );

      expect(screen.getByRole("heading", { level: 1 }).className).toContain("text-[22px]");
    });

    it.each(["reading", "table"] as const)(
      "takes the comfortable ramp from the %s width",
      (width: PageWidth) => {
        render(
          <PageTemplate title="Tus pedidos" width={width}>
            contenido
          </PageTemplate>,
        );

        expect(screen.getByRole("heading", { level: 1 }).className).toContain("text-[34px]");
      },
    );

    it("lets a caller override the ramp the width would have chosen", () => {
      render(
        <PageTemplate title="Editar producto" width="reading" density="compact">
          contenido
        </PageTemplate>,
      );

      expect(screen.getByRole("heading", { level: 1 }).className).toContain("text-[22px]");
    });

    it("sets a mono title in the mono face and drops the tracking with it", () => {
      render(
        <PageTemplate title="AK-2026-000412" width="reading" mono>
          contenido
        </PageTemplate>,
      );

      const heading = screen.getByRole("heading", { level: 1 });
      expect(heading.className).toContain("font-mono");
      // The identifier ramp is tracked at 0; leaving the comfortable tracking on
      // would space a monospaced order number like a headline.
      expect(heading.className).toContain("tracking-normal");
      expect(heading.className).not.toContain("tracking-[0.4px]");
    });

    it("renders the title adornment inside the heading", () => {
      render(
        <PageTemplate
          title="AK-2026-000412"
          width="reading"
          mono
          titleAdornment={<span>Enviado</span>}
        >
          contenido
        </PageTemplate>,
      );

      // Asserted through the accessible NAME rather than the DOM: the badge is
      // inside the h1 precisely so it is announced as part of the title.
      expect(
        screen.getByRole("heading", { level: 1, name: "AK-2026-000412 Enviado" }),
      ).toBeInTheDocument();
    });
  });

  describe("breadcrumb", () => {
    it("renders a named nav of ancestor links", () => {
      render(
        <PageTemplate
          title="AK-2026-000412"
          width="reading"
          breadcrumb={{
            label: "Ruta",
            links: [
              { label: "Mi cuenta", href: "/account" },
              { label: "Pedidos", href: "/account/orders" },
            ],
          }}
        >
          contenido
        </PageTemplate>,
      );

      const trail = screen.getByRole("navigation", { name: "Ruta" });
      expect(trail).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Pedidos" })).toHaveAttribute(
        "href",
        "/account/orders",
      );
      // The current page is the h1 and must not appear again as a dead crumb.
      expect(trail.textContent).not.toContain("AK-2026-000412");
    });

    it("renders no nav when there is no breadcrumb", () => {
      render(
        <PageTemplate title="Pedidos" width="admin">
          contenido
        </PageTemplate>,
      );

      expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });

    it("renders no nav for an empty trail", () => {
      render(
        <PageTemplate title="Pedidos" width="admin" breadcrumb={{ label: "Ruta", links: [] }}>
          contenido
        </PageTemplate>,
      );

      expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });
  });

  describe("optional regions", () => {
    it("renders only the header and the content when nothing else is supplied", () => {
      const { container } = render(
        <PageTemplate title="Pedidos" width="admin">
          contenido
        </PageTemplate>,
      );

      expect(container.firstElementChild?.childElementCount).toBe(2);
    });

    it("renders the filter slot as its own region", () => {
      const { container } = render(
        <PageTemplate
          title="Pedidos"
          width="admin"
          filters={<form aria-label="Filtros">campos</form>}
        >
          contenido
        </PageTemplate>,
      );

      expect(screen.getByRole("form", { name: "Filtros" })).toBeInTheDocument();
      expect(container.firstElementChild?.childElementCount).toBe(3);
    });

    it("renders the footer with pagination and the result summary", () => {
      const { container } = render(
        <PageTemplate
          title="Pedidos"
          width="admin"
          pagination={<nav aria-label="Paginación">controles</nav>}
          summary="Mostrando 1–25"
        >
          contenido
        </PageTemplate>,
      );

      expect(screen.getByRole("navigation", { name: "Paginación" })).toBeInTheDocument();
      expect(screen.getByText("Mostrando 1–25")).toBeInTheDocument();
      expect(container.firstElementChild?.childElementCount).toBe(3);
    });

    it("renders no footer when neither half is supplied", () => {
      const { container } = render(
        <PageTemplate title="Pedidos" width="admin">
          contenido
        </PageTemplate>,
      );

      expect(container.querySelector("footer")).toBeNull();
    });

    it("opens the footer for a summary alone, and keeps it right-aligned", () => {
      const { container } = render(
        <PageTemplate title="Pedidos" width="admin" summary="24 pedidos">
          contenido
        </PageTemplate>,
      );

      const footer = container.querySelector("footer");
      expect(footer).not.toBeNull();
      expect(footer?.childElementCount).toBe(1);
      // A lone child in a space-between row sits on the LEFT, which is why the
      // summary carries its own auto margin.
      expect(screen.getByText("24 pedidos").className).toContain("ms-auto");
    });

    it("opens the footer for pagination alone", () => {
      const { container } = render(
        <PageTemplate
          title="Pedidos"
          width="admin"
          pagination={<nav aria-label="Paginación">controles</nav>}
        >
          contenido
        </PageTemplate>,
      );

      expect(container.querySelector("footer")).not.toBeNull();
      expect(screen.getByRole("navigation", { name: "Paginación" })).toBeInTheDocument();
    });

    it("treats a false slot as empty rather than opening an empty footer", () => {
      // `{hasRows && <CursorPagination …/>}` yields `false`, not `undefined`,
      // and a footer opened for it is a visible empty row with a gap above it.
      const { container } = render(
        <PageTemplate title="Pedidos" width="admin" pagination={false} summary={false}>
          contenido
        </PageTemplate>,
      );

      expect(container.querySelector("footer")).toBeNull();
      expect(container.firstElementChild?.childElementCount).toBe(2);
    });
  });
});
