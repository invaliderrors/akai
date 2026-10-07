import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { ContentRow, DisclosureRow, GroupedList, ValueRow } from "./grouped-list";

/**
 * Rows read the message catalogue, so any render needs the provider in context. Every render goes through here so a test never
 * fails for the wrong reason when it grows an `href`.
 */
function renderList(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="es" messages={{}}>
      {ui}
    </NextIntlClientProvider>,
  );
}

/** The row's own box — the `<a>`, `<button>` or `<div>` inside the `<li>`. */
function boxOf(item: HTMLElement): Element {
  const box = item.firstElementChild;
  if (box === null) {
    throw new Error("row rendered no box");
  }
  return box;
}

/** The 1px rule each row draws under itself. Always the last child of the `<li>`. */
function separatorOf(item: HTMLElement): Element {
  const separator = item.lastElementChild;
  if (separator === null) {
    throw new Error("row rendered no separator");
  }
  return separator;
}

describe("<GroupedList />", () => {
  it("is a list of list items", () => {
    // order-detail.test.tsx counts listitems inside the shipments region, and
    // that count is what a screen-reader user hears as "list, 3 items".
    renderList(
      <GroupedList id="account">
        <DisclosureRow label="Direcciones" href="/cuenta/direcciones" />
        <DisclosureRow label="Devoluciones" href="/cuenta/devoluciones" />
        <DisclosureRow label="Seguridad" href="/cuenta/seguridad" />
      </GroupedList>,
    );

    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(3);
  });

  it("names itself with the header it renders", () => {
    renderList(
      <GroupedList id="account" label="Tu cuenta">
        <ValueRow label="Correo" value="ana@example.es" />
      </GroupedList>,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Tu cuenta" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Tu cuenta" })).toBeInTheDocument();
  });

  it("renders the header at the level the caller asks for", () => {
    renderList(
      <GroupedList id="account" label="Datos" headingAs="h3">
        <ValueRow label="Nombre" value="Ana" />
      </GroupedList>,
    );

    expect(screen.getByRole("heading", { level: 3, name: "Datos" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });

  it("takes its name from a heading OUTSIDE it when asked to", () => {
    // The returns picker draws the group under a <legend>, which is already the
    // fieldset's name — repeating it as a SectionHeader would say it twice.
    renderList(
      <>
        <h2 id="items-heading">Artículos a devolver</h2>
        <GroupedList id="items" labelledBy="items-heading">
          <ValueRow label="Camiseta" value="×1" />
        </GroupedList>
      </>,
    );

    expect(screen.getByRole("list", { name: "Artículos a devolver" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("describes the list with the footnote it renders, in DOM order", () => {
    renderList(
      <GroupedList
        id="password"
        label="Contraseña"
        error="Tiene 8 caracteres; faltan 4."
        hint="Al menos 12 caracteres."
      >
        <ValueRow label="Nueva" value="········" />
      </GroupedList>,
    );

    // Error first, matching the drawn order — the error is what just changed,
    // the hint is standing text — and aria-describedby follows the DOM, which
    // is the same invariant field.tsx holds with its two the other way round.
    expect(screen.getByRole("list")).toHaveAttribute("aria-describedby", "password-error password-hint");
    expect(screen.getByRole("alert")).toHaveTextContent("Tiene 8 caracteres; faltan 4.");
    expect(document.getElementById("password-hint")).toHaveTextContent("Al menos 12 caracteres.");
  });

  it("names only the footnote paragraphs it actually rendered", () => {
    // A dangling aria-describedby is silently dropped by some screen readers
    // and read as nothing by others, so an id may only be named when it exists.
    renderList(
      <GroupedList id="comms" hint="Como mucho un correo al mes.">
        <ValueRow label="Novedades" value="Activado" />
      </GroupedList>,
    );

    expect(screen.getByRole("list")).toHaveAttribute("aria-describedby", "comms-hint");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("carries no description at all when it has no footnote", () => {
    renderList(
      <GroupedList id="plain">
        <ValueRow label="Idioma" value="Español" />
      </GroupedList>,
    );

    expect(screen.getByRole("list")).not.toHaveAttribute("aria-describedby");
  });

  it("renders the header action without folding it into the list's name", () => {
    renderList(
      <GroupedList id="orders" label="Pedidos recientes" action={<button type="button">Ver todos</button>}>
        <ContentRow title="AK-2026-000412" />
      </GroupedList>,
    );

    expect(screen.getByRole("button", { name: "Ver todos" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Pedidos recientes" })).toBeInTheDocument();
  });

  it("hides the last row's separator from the list itself", () => {
    // A row cannot know it is last, so the one selector that suppresses the
    // trailing rule lives here. If it is ever dropped, the card grows a stray
    // hairline across its bottom edge and nothing else changes.
    renderList(
      <GroupedList id="account">
        <ValueRow label="Nombre" value="Ana" />
      </GroupedList>,
    );

    expect(screen.getByRole("list").className).toContain("[&>li:last-child>div:last-child]:hidden");
  });
});

describe("<DisclosureRow />", () => {
  it("is a link, named by its label, when it navigates", () => {
    renderList(
      <GroupedList id="account">
        <DisclosureRow label="Direcciones" href="/cuenta/direcciones" />
      </GroupedList>,
    );

    const link = screen.getByRole("link", { name: "Direcciones" });
    expect(link).toHaveAttribute("href", "/cuenta/direcciones");
    // The chevron is decoration: it must not join the name it points at.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("is a button, and calls its handler, when it acts", async () => {
    const onClick = vi.fn();
    renderList(
      <GroupedList id="account">
        <DisclosureRow label="Cerrar sesión" onClick={onClick} />
      </GroupedList>,
    );

    const button = screen.getByRole("button", { name: "Cerrar sesión" });
    // Never type=submit: a row inside a form that silently submits it is the
    // bug this default prevents.
    expect(button).toHaveAttribute("type", "button");

    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("is neither a link nor a button when it only displays", () => {
    renderList(
      <GroupedList id="account">
        <DisclosureRow label="Verificación en dos pasos" value="Activada" />
      </GroupedList>,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Verificación en dos pasos")).toBeInTheDocument();
    expect(screen.getByText("Activada")).toBeInTheDocument();
  });

  it("draws a chevron only where there is somewhere to go", () => {
    const { container: goes } = renderList(
      <GroupedList id="a">
        <DisclosureRow label="Direcciones" href="/cuenta/direcciones" />
      </GroupedList>,
    );
    const { container: stays } = renderList(
      <GroupedList id="b">
        <DisclosureRow label="Correo" value="ana@example.es" />
      </GroupedList>,
    );
    const { container: suppressed } = renderList(
      <GroupedList id="c">
        <DisclosureRow label="Novedades" onClick={() => undefined} chevron={false} />
      </GroupedList>,
    );

    expect(goes.querySelector("svg")).not.toBeNull();
    // A chevron on a row that goes nowhere is a promise the row cannot keep.
    expect(stays.querySelector("svg")).toBeNull();
    expect(suppressed.querySelector("svg")).toBeNull();
  });

  it("steps its separator in behind a leading tile", () => {
    // The whole reason the separator is a div and not a border: the rule starts
    // at the row's own text origin, so a list that mixes iconed and plain rows
    // steps it in and out exactly as iOS does.
    renderList(
      <GroupedList id="account">
        <DisclosureRow label="Direcciones" icon="map-pin" href="/cuenta/direcciones" />
        <DisclosureRow label="Idioma" value="Español" />
      </GroupedList>,
    );

    const [iconed, plain] = screen.getAllByRole("listitem");
    expect(iconed).toBeDefined();
    expect(plain).toBeDefined();
    if (iconed === undefined || plain === undefined) {
      throw new Error("expected two rows");
    }

    expect(separatorOf(iconed).className).toContain("ml-[calc(var(--cell-px)+40px)]");
    expect(separatorOf(plain).className).toContain("ml-[var(--cell-px)]");
  });

  it("tints the leading tile through a role token, never a colour prop", () => {
    renderList(
      <GroupedList id="account">
        <DisclosureRow label="Devoluciones" icon="undo-2" iconTone="warning" href="/cuenta/devoluciones" />
      </GroupedList>,
    );

    expect(screen.getByRole("link").innerHTML).toContain("bg-[var(--warning)]");
  });

  it("sets focus-visible:outline-none before painting its own ring", () => {
    // KEEP THIS. globals.css declares :focus-visible inside @layer base so that
    // a utility can win — but only a utility that is actually emitted. The ring
    // is INSET here and nowhere else in the kit: the card is overflow-hidden, so
    // the standard outer 4px ring would be sliced off at both edges of the row.
    renderList(
      <GroupedList id="account">
        <DisclosureRow label="Direcciones" href="/cuenta/direcciones" />
      </GroupedList>,
    );

    const className = screen.getByRole("link").className;
    expect(className).toContain("focus-visible:outline-none");
    expect(className).toContain("focus-visible:shadow-[inset_0_0_0_4px_var(--focus-ring)]");
  });
});

describe("<ValueRow />", () => {
  it("renders its label and its value", () => {
    renderList(
      <GroupedList id="profile">
        <ValueRow label="Correo" value="ana@example.es" />
      </GroupedList>,
    );

    expect(screen.getByText("Correo")).toBeInTheDocument();
    expect(screen.getByText("ana@example.es")).toBeInTheDocument();
  });

  it("flips the label column and the value's edge with density", () => {
    // Desktop and phone are two layouts, not one layout at two sizes: at 375px
    // a right-aligned value sits half a screen from the label that names it.
    const { container: desktop } = renderList(
      <GroupedList id="desktop">
        <ValueRow label="Nombre" value="Ana" density="compact" />
      </GroupedList>,
    );
    const { container: phone } = renderList(
      <GroupedList id="phone">
        <ValueRow label="Nombre" value="Ana" density="comfortable" />
      </GroupedList>,
    );

    const desktopRow = within(desktop).getByRole("listitem");
    const phoneRow = within(phone).getByRole("listitem");

    expect(boxOf(desktopRow).className).toContain("grid-cols-[140px_minmax(0,1fr)]");
    expect(boxOf(desktopRow).innerHTML).toContain("text-right");
    expect(boxOf(phoneRow).className).toContain("grid-cols-[110px_minmax(0,1fr)]");
    expect(boxOf(phoneRow).innerHTML).toContain("text-left");
  });

  it("keeps the rule under the label, since it has no leading slot", () => {
    renderList(
      <GroupedList id="profile">
        <ValueRow label="Idioma" value="Español" />
      </GroupedList>,
    );

    expect(separatorOf(screen.getByRole("listitem")).className).toContain("ml-[var(--cell-px)]");
  });

  it("becomes a button when it acts", async () => {
    const onClick = vi.fn();
    renderList(
      <GroupedList id="profile">
        <ValueRow label="Idioma" value="Español" onClick={onClick} />
      </GroupedList>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Idioma Español" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("<ContentRow />", () => {
  it("renders both lines and both trailing slots", () => {
    renderList(
      <GroupedList id="orders">
        <ContentRow
          title="AK-2026-000412"
          meta="28 ago · Camiseta oversize M y 1 más"
          aside={<span>En tránsito</span>}
          trailing="59,80 €"
          href="/cuenta/pedidos/AK-2026-000412"
        />
      </GroupedList>,
    );

    const link = screen.getByRole("link");
    expect(within(link).getByText("AK-2026-000412")).toBeInTheDocument();
    expect(within(link).getByText("28 ago · Camiseta oversize M y 1 más")).toBeInTheDocument();
    expect(within(link).getByText("En tránsito")).toBeInTheDocument();
    expect(within(link).getByText("59,80 €")).toBeInTheDocument();
  });

  it("steps its separator in behind whatever the caller leads with", () => {
    renderList(
      <GroupedList id="items">
        <ContentRow title="Camiseta oversize M" leading={<input type="checkbox" aria-label="Devolver" />} />
        <ContentRow title="BCAA 2:1:1 300 g" />
      </GroupedList>,
    );

    const [withControl, without] = screen.getAllByRole("listitem");
    if (withControl === undefined || without === undefined) {
      throw new Error("expected two rows");
    }

    expect(separatorOf(withControl).className).toContain("ml-[calc(var(--cell-px)+40px)]");
    expect(separatorOf(without).className).toContain("ml-[var(--cell-px)]");
  });

  it("is a row and a bit tall, derived from --row-h rather than a second number", () => {
    renderList(
      <GroupedList id="orders">
        <ContentRow title="AK-2026-000398" meta="11 ago · Coach jacket L" />
      </GroupedList>,
    );

    expect(boxOf(screen.getByRole("listitem")).className).toContain("min-h-[calc(var(--row-h)+12px)]");
  });

  it("is neither a link nor a button when it only displays a record", () => {
    renderList(
      <GroupedList id="items">
        <ContentRow title="Camiseta oversize M" meta="AK-TEE-BLK-M" trailing="29,90 €" />
      </GroupedList>,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("listitem")).toBeInTheDocument();
  });
});
