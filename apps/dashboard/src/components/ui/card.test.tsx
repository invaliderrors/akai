import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Card, CardDivider, SectionHeader } from "./card";

describe("<Card />", () => {
  it("renders its title as a level-2 heading by default", () => {
    render(<Card title="Dirección de facturación">contenido</Card>);

    expect(screen.getByRole("heading", { level: 2, name: "Dirección de facturación" })).toBeInTheDocument();
  });

  it("renders the title at the level the caller asks for", () => {
    // A card nested under a page's own <h2> has to be an <h3> or the outline
    // skips a level — which the card cannot work out for itself.
    render(
      <Card title="Envío" titleAs="h3">
        contenido
      </Card>,
    );

    expect(screen.getByRole("heading", { level: 3, name: "Envío" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });

  it("renders no heading at all when it has no title", () => {
    render(<Card>contenido</Card>);

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByText("contenido")).toBeInTheDocument();
  });

  it("renders the trailing action slot", () => {
    render(
      <Card title="Direcciones" action={<button type="button">Añadir</button>}>
        contenido
      </Card>,
    );

    expect(screen.getByRole("button", { name: "Añadir" })).toBeInTheDocument();
  });

  it("names itself with its own title when given a title id", () => {
    render(
      <Card title="Pedidos recientes" titleId="recent-orders-heading">
        contenido
      </Card>,
    );

    expect(screen.getByRole("region", { name: "Pedidos recientes" })).toBeInTheDocument();
  });

  it("takes its name from a heading OUTSIDE it when asked to", () => {
    render(
      <>
        <h2 id="shipping-heading">Envío</h2>
        <Card labelledBy="shipping-heading">contenido</Card>
      </>,
    );

    expect(screen.getByRole("region", { name: "Envío" })).toBeInTheDocument();
  });

  it("stays an unnamed generic container when nothing names it", () => {
    // An unnamed <section> is generic, not a region — so a card used purely for
    // grouping does not add a landmark a screen-reader user has to step past.
    render(<Card>contenido</Card>);

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("renders a divider that is not announced", () => {
    render(
      <Card>
        <p>arriba</p>
        <CardDivider />
        <p>abajo</p>
      </Card>,
    );

    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });
});

describe("<SectionHeader />", () => {
  it("emits an id a parent section can consume with aria-labelledby", () => {
    render(
      <section aria-labelledby="orders-heading">
        <SectionHeader id="orders-heading" title="Pedidos recientes" />
        <Card>contenido</Card>
      </section>,
    );

    expect(screen.getByRole("region", { name: "Pedidos recientes" })).toBeInTheDocument();
  });

  it("keeps the action out of the accessible name it lends its section", () => {
    // The id is on the heading rather than on the header row precisely so a
    // "Ver todos" link beside it does not become part of the section's name.
    render(
      <section aria-labelledby="orders-heading">
        <SectionHeader
          id="orders-heading"
          title="Pedidos recientes"
          action={<button type="button">Ver todos</button>}
        />
      </section>,
    );

    expect(screen.getByRole("region", { name: "Pedidos recientes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver todos" })).toBeInTheDocument();
  });

  it("leaves the title's own casing alone at comfortable density", () => {
    // The grouped header's capitals are `text-transform`, not the string: a
    // screen reader must read "Mi cuenta", not the shouted version.
    render(<SectionHeader id="account-heading" title="Mi cuenta" />);

    expect(screen.getByRole("heading", { name: "Mi cuenta" })).toBeInTheDocument();
  });

  it("renders a heading at compact density too", () => {
    render(<SectionHeader id="totals-heading" title="Totales" density="compact" as="h3" />);

    expect(screen.getByRole("heading", { level: 3, name: "Totales" })).toBeInTheDocument();
  });
});
