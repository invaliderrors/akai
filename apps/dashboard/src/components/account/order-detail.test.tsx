import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import type { OrderDetail } from "@/lib/account";
import { OrderDetailView } from "./order-detail";
import {
  buildOrder,
  buildPayment,
  buildShipment,
} from "@/lib/account/fixtures";
import esMessages from "../../../messages/es.json";

function renderDetail(detail: Partial<OrderDetail> = {}) {
  const full: OrderDetail = {
    order: detail.order ?? buildOrder(),
    shipments: detail.shipments ?? [],
    payment: detail.payment ?? null,
  };

  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <OrderDetailView detail={full} />
    </NextIntlClientProvider>,
  );
}

describe("OrderDetailView", () => {
  it("leaves the page heading to PageTemplate", () => {
    // The order number is the page TITLE and the status its adornment, both
    // rendered by the route. A heading here would give the document two.
    renderDetail();

    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  describe("line items", () => {
    it("renders each line with its snapshotted name, quantity and totals", () => {
      renderDetail();

      expect(screen.getByText("Camiseta Oversize")).toBeInTheDocument();
      expect(screen.getByText("M")).toBeInTheDocument();
      expect(screen.getByText("REF AK-TEE-BLK-M")).toBeInTheDocument();

      // Both fixture lines have quantity 1, so unit price and line total are the
      // same figure and legitimately appear twice per row. Asserting "at least
      // one" would pass even if the line-total column stopped rendering.
      expect(screen.getAllByText(/89,99/)).toHaveLength(2);
      expect(screen.getAllByText(/24,99/)).toHaveLength(2);
    });
  });

  describe("totals", () => {
    it("renders the full breakdown and the grand total", () => {
      renderDetail();

      const summary = screen.getByRole("region", { name: "Resumen" });
      expect(within(summary).getByText(/114,98/)).toBeInTheDocument(); // subtotal
      expect(within(summary).getByText(/−4,00/)).toBeInTheDocument(); // discount
      expect(within(summary).getByText(/10,00/)).toBeInTheDocument(); // shipping
      expect(within(summary).getByText(/19,96/)).toBeInTheDocument(); // tax
      expect(within(summary).getByText(/120,98/)).toBeInTheDocument(); // grand total
    });

    it("hides the discount row when nothing was discounted", () => {
      // A "−0,00 €" line is noise that makes customers wonder what they lost.
      renderDetail({ order: buildOrder({ discountTotal: 0 }) });

      const summary = screen.getByRole("region", { name: "Resumen" });
      expect(within(summary).queryByText("Descuento")).not.toBeInTheDocument();
    });

    it("shows a refunded row only once money has actually gone back", () => {
      renderDetail({
        order: buildOrder({ refundedTotal: 2_499, status: "PARTIALLY_REFUNDED" }),
      });

      const summary = screen.getByRole("region", { name: "Resumen" });
      expect(within(summary).getByText("Reembolsado")).toBeInTheDocument();
      // U+2212 MINUS, not a hyphen: the figures are a tabular column and the
      // hyphen is the one glyph in it with no tabular width.
      expect(within(summary).getByText(/−24,99/)).toBeInTheDocument();
    });
  });

  describe("payment", () => {
    it("shows the payment status and masked card when a payment exists", () => {
      renderDetail({ payment: buildPayment() });

      const payment = screen.getByRole("region", { name: "Pago" });
      // "Cobrado", not "Pagado": the badge is keyed on (domain, member), so a
      // SUCCEEDED payment and a PAID order are deliberately different strings.
      expect(within(payment).getByText("Cobrado")).toBeInTheDocument();
      expect(within(payment).getByText("visa terminada en 4242")).toBeInTheDocument();
    });

    it("never renders the provider's own failure prose to the customer", () => {
      renderDetail({
        payment: buildPayment({
          status: "FAILED",
          capturedAt: null,
          failureCode: "card_declined",
          failureMessage: "Your card was declined by the issuer.",
        }),
      });

      const payment = screen.getByRole("region", { name: "Pago" });
      expect(within(payment).getByText("Pago fallido")).toBeInTheDocument();
      expect(screen.queryByText(/declined by the issuer/)).not.toBeInTheDocument();
    });

    it("tells the customer we are still confirming while awaiting payment", () => {
      // An order becomes PAID only via a signed provider webhook, so this state is
      // normal for seconds after checkout and must not read as a failure.
      renderDetail({ order: buildOrder({ status: "AWAITING_PAYMENT", paidAt: null }) });

      const payment = screen.getByRole("region", { name: "Pago" });
      expect(within(payment).getByText(/Estamos confirmando tu pago/)).toBeInTheDocument();
    });

    it("says the payment failed when the order failed", () => {
      renderDetail({ order: buildOrder({ status: "FAILED", paidAt: null }) });

      const payment = screen.getByRole("region", { name: "Pago" });
      expect(within(payment).getByText(/El pago no se ha completado/)).toBeInTheDocument();
    });
  });

  describe("delivery progress", () => {
    it("marks the last milestone that actually happened as the current step", () => {
      renderDetail({ shipments: [buildShipment()] });

      const progress = screen.getByRole("region", { name: "Seguimiento" });
      const current = within(progress)
        .getAllByRole("listitem")
        .filter((step) => step.getAttribute("aria-current") === "step")
        .map((step) => step.textContent ?? "");

      expect(current).toHaveLength(1);
      expect(current.join("")).toContain("Enviado");
      // Nothing has been delivered, and no field carries an estimate — so the
      // step says pending rather than inventing a date.
      expect(within(progress).getByText("Pendiente")).toBeInTheDocument();
    });

    it("leaves no step current once every parcel has arrived", () => {
      renderDetail({
        shipments: [
          buildShipment({ status: "DELIVERED", deliveredAt: "2026-03-05T11:00:00.000Z" }),
        ],
        order: buildOrder({ status: "DELIVERED" }),
      });

      const progress = screen.getByRole("region", { name: "Seguimiento" });
      const current = within(progress)
        .getAllByRole("listitem")
        .filter((step) => step.getAttribute("aria-current") === "step");

      expect(current).toHaveLength(0);
    });

    it("draws no progress rail for an order that will never ship", () => {
      // Two grey steps still to come would read as an order still on its way.
      renderDetail({ order: buildOrder({ status: "CANCELLED" }) });

      expect(screen.queryByRole("region", { name: "Seguimiento" })).not.toBeInTheDocument();
    });
  });

  describe("shipments", () => {
    it("explains that nothing has shipped yet when there are no parcels", () => {
      renderDetail({ shipments: [] });

      const shipments = screen.getByRole("region", { name: "Envíos" });
      expect(
        within(shipments).getByText(/Todavía no se ha enviado/),
      ).toBeInTheDocument();
    });

    it("renders carrier, tracking number and an external tracking link", () => {
      renderDetail({ shipments: [buildShipment()] });

      const shipments = screen.getByRole("region", { name: "Envíos" });
      // Exact match: /SEUR/ also matches the tracking number "SEUR-9981234",
      // so a loose regex here would pass with the carrier name missing.
      expect(within(shipments).getByText("SEUR")).toBeInTheDocument();
      expect(within(shipments).getByText(/SEUR-9981234/)).toBeInTheDocument();

      const link = within(shipments).getByRole("link", { name: "Seguir el envío" });
      expect(link).toHaveAttribute("href", "https://www.seur.com/track/SEUR-9981234");
      // Carrier sites are third-party: never hand them window.opener.
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    });

    it("renders one entry per parcel, because an order can ship in several", () => {
      renderDetail({
        shipments: [
          buildShipment(),
          buildShipment({
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            carrier: "Correos Express",
            trackingNumber: "CEX-5512",
            trackingUrl: null,
            status: "DELIVERED",
            deliveredAt: "2026-03-05T11:00:00.000Z",
          }),
        ],
      });

      const shipments = screen.getByRole("region", { name: "Envíos" });
      expect(within(shipments).getAllByRole("listitem")).toHaveLength(2);
      expect(within(shipments).getByText(/Correos Express/)).toBeInTheDocument();
      expect(within(shipments).getByText(/Entregado el/)).toBeInTheDocument();
    });
  });

  describe("invoice", () => {
    it("shows the invoice number once one has been allocated", () => {
      renderDetail();

      const invoice = screen.getByRole("region", { name: "Factura" });
      expect(within(invoice).getByText("Factura INV-2026-000045")).toBeInTheDocument();
    });

    it("offers no download, because the invoices module ships no file", () => {
      renderDetail();

      const invoice = screen.getByRole("region", { name: "Factura" });
      expect(within(invoice).queryByRole("link")).not.toBeInTheDocument();
    });

    it("explains the invoice is pending when the order has no number yet", () => {
      // Invoice numbers come from a gap-free sequence allocated at PAID only,
      // so a null number is the normal state of an unpaid order, not an error.
      renderDetail({
        order: buildOrder({
          invoiceNumber: null,
          status: "AWAITING_PAYMENT",
          paidAt: null,
        }),
      });

      const invoice = screen.getByRole("region", { name: "Factura" });
      expect(within(invoice).getByText(/La factura estará disponible/)).toBeInTheDocument();
    });
  });

  describe("addresses", () => {
    it("renders the snapshotted shipping address", () => {
      renderDetail();

      const addresses = screen.getByRole("region", { name: "Direcciones" });
      expect(within(addresses).getByText("Calle Mayor 12")).toBeInTheDocument();
      expect(within(addresses).getByText("28013 Madrid")).toBeInTheDocument();
    });

    it("says the billing address is the shipping one instead of printing it twice", () => {
      // The fixture bills where it ships, as most orders do. Six identical
      // lines side by side invite a comparison there is no difference to find.
      renderDetail();

      const addresses = screen.getByRole("region", { name: "Direcciones" });
      expect(within(addresses).getByText("La misma que la de envío")).toBeInTheDocument();
      expect(within(addresses).getAllByText("Calle Mayor 12")).toHaveLength(1);
    });

    it("prints both addresses when they actually differ", () => {
      renderDetail({
        order: buildOrder({
          billingAddress: {
            firstName: "Elena",
            lastName: "Ruiz",
            company: "Akai SL",
            line1: "Gran Vía 3",
            line2: null,
            city: "Madrid",
            region: null,
            postalCode: "28013",
            countryCode: "ES",
            phone: null,
          },
        }),
      });

      const addresses = screen.getByRole("region", { name: "Direcciones" });
      expect(within(addresses).getByText("Gran Vía 3")).toBeInTheDocument();
      expect(within(addresses).getByText("Calle Mayor 12")).toBeInTheDocument();
      expect(within(addresses).queryByText("La misma que la de envío")).not.toBeInTheDocument();
    });

    it("skips address lines the customer left blank", () => {
      // company, line2, region and phone are all null in the fixture; rendering
      // them would leave visible gaps in the address block.
      renderDetail();

      const addresses = screen.getByRole("region", { name: "Direcciones" });
      expect(within(addresses).queryByText("null")).not.toBeInTheDocument();
    });
  });
});
