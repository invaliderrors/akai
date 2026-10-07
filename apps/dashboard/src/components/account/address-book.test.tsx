import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import type { Address } from "@akai/contracts";
import type { ApiResult } from "@/lib/api/errors";
import type { CreateAddressRequest, UpdateAddressRequest } from "@/lib/account";
import { ToastProvider } from "@/components/ui/toast";
import { AddAddressButton, AddressBook, AddressBookProvider } from "./address-book";
import { buildAddress } from "@/lib/account/fixtures";
import esMessages from "../../../messages/es.json";

type AddressResult = ApiResult<Address>;
type DeleteResult = ApiResult<undefined>;

const okAddress = (address: Address): AddressResult => ({
  ok: true,
  status: 200,
  data: address,
});

const okDelete: DeleteResult = { ok: true, status: 204, data: undefined };

function renderBook(
  options: {
    addresses?: readonly Address[];
    onCreate?: (input: CreateAddressRequest) => Promise<AddressResult>;
    onUpdate?: (
      id: string,
      input: UpdateAddressRequest,
    ) => Promise<AddressResult>;
    onDelete?: (id: string) => Promise<DeleteResult>;
  } = {},
) {
  const addresses = options.addresses ?? [buildAddress()];
  // A distinct id: the default fixture's id already belongs to the address in
  // the list, and returning it from a CREATE would append a duplicate key —
  // modelling a server behaviour that cannot happen and hiding real key bugs
  // behind an expected warning.
  const onCreate =
    options.onCreate ??
    vi.fn(async () =>
      okAddress(buildAddress({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" })),
    );
  const onUpdate = options.onUpdate ?? vi.fn(async () => okAddress(buildAddress()));
  const onDelete = options.onDelete ?? vi.fn(async () => okDelete);

  render(
    // The three wrappers the PAGE supplies, in the page's own order.
    // `ToastProvider` because the undo toast is part of the delete flow and
    // `useToast` throws without it; `AddressBookProvider` because the create
    // action is drawn in the page header, which `PageTemplate` renders as a
    // SIBLING of the list rather than inside it.
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <ToastProvider closeLabel="Cerrar">
        <AddressBookProvider>
          <AddAddressButton />
          <AddressBook
            addresses={addresses}
            onCreate={onCreate}
            onUpdate={onUpdate}
            onDelete={onDelete}
          />
        </AddressBookProvider>
      </ToastProvider>
    </NextIntlClientProvider>,
  );

  return { onCreate, onUpdate, onDelete };
}

/** The delete confirmation, scoped so "Eliminar" cannot match a row's button. */
function confirmDialog(): HTMLElement {
  return screen.getByRole("alertdialog");
}

describe("AddressBook", () => {
  it("shows an empty state with a create action when there are no addresses", () => {
    renderBook({ addresses: [] });

    expect(screen.getByText("No tienes direcciones guardadas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Añadir dirección" })).toBeInTheDocument();
  });

  it("lists saved addresses with their type and default flag", () => {
    renderBook();

    expect(screen.getByText("Calle 10 # 43-21")).toBeInTheDocument();
    expect(screen.getByText(/Medellín, Antioquia/)).toBeInTheDocument();
    expect(screen.getByText("Envío")).toBeInTheDocument();
    // The checkmark IS the default marker, so it is an image with a name
    // rather than decoration beside a redundant word.
    expect(screen.getByRole("img", { name: "Predeterminada" })).toBeInTheDocument();
  });

  it("names each row's actions after the address they act on", () => {
    // Three rows of "Editar, botón" is a list a screen-reader user cannot use.
    renderBook();

    expect(
      screen.getByRole("button", { name: "Editar Calle 10 # 43-21" }),
    ).toHaveTextContent("Editar");
    expect(
      screen.getByRole("button", { name: "Eliminar Calle 10 # 43-21" }),
    ).toHaveTextContent("Eliminar");
  });

  describe("creating", () => {
    it("opens a blank form with no departamento chosen and Colombia fixed", async () => {
      const user = userEvent.setup();
      renderBook();

      await user.click(screen.getByRole("button", { name: "Añadir dirección" }));

      const form = screen.getByRole("form", { name: "Nueva dirección" });
      expect(within(form).queryByLabelText(/País/)).toBeNull();
      expect(within(form).getByText("Solo enviamos a Colombia.")).toBeInTheDocument();
      expect(within(form).getByLabelText(/Departamento/)).toHaveValue("");
      expect(within(form).getByLabelText(/^Dirección/)).toHaveValue("");
    });

    it("keeps the saved addresses on screen behind the sheet", async () => {
      // The form used to REPLACE the list, which hid the very addresses the
      // customer was comparing the new one against.
      const user = userEvent.setup();
      renderBook();

      await user.click(screen.getByRole("button", { name: "Añadir dirección" }));

      expect(screen.getByRole("form", { name: "Nueva dirección" })).toBeInTheDocument();
      expect(screen.getByText("Calle 10 # 43-21")).toBeInTheDocument();
    });

    it("submits a Colombian address with nulls for blank optional fields", async () => {
      const user = userEvent.setup();
      const { onCreate } = renderBook();

      await user.click(screen.getByRole("button", { name: "Añadir dirección" }));

      const form = screen.getByRole("form", { name: "Nueva dirección" });
      await user.type(within(form).getByLabelText(/^Nombre/), "Ana");
      await user.type(within(form).getByLabelText(/Apellidos/), "López");
      await user.type(within(form).getByLabelText(/^Dirección/), "Carrera 7 # 72-41");
      await user.selectOptions(within(form).getByLabelText(/Departamento/), "Bogotá, D.C.");
      await user.type(within(form).getByLabelText(/Ciudad/), "Bogotá");
      await user.click(within(form).getByRole("button", { name: "Guardar" }));

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith({
          type: "SHIPPING",
          firstName: "Ana",
          lastName: "López",
          company: null,
          line1: "Carrera 7 # 72-41",
          line2: null,
          city: "Bogotá",
          region: "Bogotá, D.C.",
          postalCode: null,
          countryCode: "CO",
          phone: null,
          isDefault: false,
        });
      });
    });

    it("blocks submission when required fields are blank — departamento included", async () => {
      const user = userEvent.setup();
      const { onCreate } = renderBook();

      await user.click(screen.getByRole("button", { name: "Añadir dirección" }));
      const form = screen.getByRole("form", { name: "Nueva dirección" });
      await user.click(within(form).getByRole("button", { name: "Guardar" }));

      expect(await within(form).findAllByText("Este campo es obligatorio.")).toHaveLength(
        5,
      );
      expect(onCreate).not.toHaveBeenCalled();
    });

    it("rejects a phone that is not a Colombian mobile and a malformed postal code", async () => {
      const user = userEvent.setup();
      const { onCreate } = renderBook();

      await user.click(screen.getByRole("button", { name: "Añadir dirección" }));
      const form = screen.getByRole("form", { name: "Nueva dirección" });

      await user.type(within(form).getByLabelText(/^Nombre/), "Ana");
      await user.type(within(form).getByLabelText(/Apellidos/), "López");
      await user.type(within(form).getByLabelText(/^Dirección/), "Carrera 7 # 72-41");
      await user.selectOptions(within(form).getByLabelText(/Departamento/), "Antioquia");
      await user.type(within(form).getByLabelText(/Ciudad/), "Medellín");
      await user.type(within(form).getByLabelText(/Celular/), "601 234 5678");
      await user.type(within(form).getByLabelText(/Código postal/), "28013");
      await user.click(within(form).getByRole("button", { name: "Guardar" }));

      expect(await within(form).findByText(/Escribe un celular colombiano/)).toBeInTheDocument();
      expect(within(form).getByText("El código postal tiene seis cifras.")).toBeInTheDocument();
      expect(onCreate).not.toHaveBeenCalled();
    });

    it("adds the new address to the list and confirms", async () => {
      const user = userEvent.setup();
      const created = buildAddress({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        line1: "Gran Via 1",
        city: "Bilbao",
        isDefault: false,
      });
      renderBook({ onCreate: vi.fn(async () => okAddress(created)) });

      await user.click(screen.getByRole("button", { name: "Añadir dirección" }));
      const form = screen.getByRole("form", { name: "Nueva dirección" });
      await user.type(within(form).getByLabelText(/^Nombre/), "Ana");
      await user.type(within(form).getByLabelText(/Apellidos/), "Lopez");
      await user.type(within(form).getByLabelText(/^Dirección/), "Gran Via 1");
      await user.selectOptions(within(form).getByLabelText(/Departamento/), "Antioquia");
      await user.type(within(form).getByLabelText(/Ciudad/), "Bilbao");
      await user.click(within(form).getByRole("button", { name: "Guardar" }));

      expect(await screen.findByText("Dirección guardada.")).toBeInTheDocument();
      expect(screen.getByText("Gran Via 1")).toBeInTheDocument();
    });
  });

  describe("editing", () => {
    it("pre-fills the form with the selected address", async () => {
      const user = userEvent.setup();
      renderBook();

      await user.click(screen.getByRole("button", { name: "Editar Calle 10 # 43-21" }));

      const form = screen.getByRole("form", { name: "Editar dirección" });
      expect(within(form).getByLabelText(/^Dirección/)).toHaveValue("Calle 10 # 43-21");
      expect(within(form).getByLabelText(/Ciudad/)).toHaveValue("Medellín");
    });

    it("passes the address id through to the update callback", async () => {
      const user = userEvent.setup();
      const { onUpdate } = renderBook();

      await user.click(screen.getByRole("button", { name: "Editar Calle 10 # 43-21" }));
      const form = screen.getByRole("form", { name: "Editar dirección" });
      await user.click(within(form).getByRole("button", { name: "Guardar" }));

      await waitFor(() => {
        expect(onUpdate).toHaveBeenCalledWith(
          "55555555-5555-4555-8555-555555555555",
          expect.objectContaining({ city: "Medellín" }),
        );
      });
    });

    it("demotes the previous default of the same type when a new one is set", async () => {
      // The API applies this rule server-side, but the sibling change is
      // invisible in the single-address response — so the list would otherwise
      // show two default checkmarks until the next full reload.
      const user = userEvent.setup();
      const existingDefault = buildAddress({ isDefault: true });
      const other = buildAddress({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        line1: "Paseo de Gracia 5",
        city: "Barcelona",
        isDefault: false,
      });
      const promoted: Address = { ...other, isDefault: true };

      renderBook({
        addresses: [existingDefault, other],
        onUpdate: vi.fn(async () => okAddress(promoted)),
      });

      await user.click(screen.getByRole("button", { name: "Editar Paseo de Gracia 5" }));
      const form = screen.getByRole("form", { name: "Editar dirección" });
      await user.click(within(form).getByRole("button", { name: "Guardar" }));

      await waitFor(() => {
        expect(screen.getAllByRole("img", { name: "Predeterminada" })).toHaveLength(1);
      });
    });

    it("returns to the list without saving when cancelled", async () => {
      const user = userEvent.setup();
      const { onUpdate } = renderBook();

      await user.click(screen.getByRole("button", { name: "Editar Calle 10 # 43-21" }));
      await user.click(screen.getByRole("button", { name: "Cancelar" }));

      expect(screen.queryByRole("form", { name: "Editar dirección" })).not.toBeInTheDocument();
      expect(screen.getByText("Calle 10 # 43-21")).toBeInTheDocument();
      expect(onUpdate).not.toHaveBeenCalled();
    });
  });

  describe("deleting", () => {
    it("asks for confirmation before deleting anything", async () => {
      // A single-click destructive action sitting next to "Edit" is one mis-tap
      // from losing data the customer cannot recover.
      const user = userEvent.setup();
      const { onDelete } = renderBook();

      await user.click(screen.getByRole("button", { name: "Eliminar Calle 10 # 43-21" }));

      const dialog = confirmDialog();
      expect(within(dialog).getByText("¿Eliminar esta dirección?")).toBeInTheDocument();
      // The alert names the record it is about, not just the action.
      expect(within(dialog).getByText("Calle 10 # 43-21, Medellín")).toBeInTheDocument();
      expect(onDelete).not.toHaveBeenCalled();
    });

    it("removes the address once confirmed and offers an undo", async () => {
      const user = userEvent.setup();
      const { onDelete } = renderBook();

      await user.click(screen.getByRole("button", { name: "Eliminar Calle 10 # 43-21" }));
      await user.click(within(confirmDialog()).getByRole("button", { name: "Eliminar" }));

      await waitFor(() => {
        expect(onDelete).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555");
      });
      expect(await screen.findByText("Dirección eliminada.")).toBeInTheDocument();
      expect(screen.queryByText("Calle 10 # 43-21")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Deshacer" })).toBeInTheDocument();
    });

    it("puts the address back when the undo is taken", async () => {
      // There is no restore endpoint and there need not be: an address is
      // eleven fields the customer already gave us, so undo is a create.
      const user = userEvent.setup();
      const restored = buildAddress({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
      const { onCreate } = renderBook({
        onCreate: vi.fn(async () => okAddress(restored)),
      });

      await user.click(screen.getByRole("button", { name: "Eliminar Calle 10 # 43-21" }));
      await user.click(within(confirmDialog()).getByRole("button", { name: "Eliminar" }));
      await user.click(await screen.findByRole("button", { name: "Deshacer" }));

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ line1: "Calle 10 # 43-21", isDefault: true }),
        );
      });
      expect(await screen.findByText("Calle 10 # 43-21")).toBeInTheDocument();
    });

    it("abandons the delete when the confirmation is cancelled", async () => {
      const user = userEvent.setup();
      const { onDelete } = renderBook();

      await user.click(screen.getByRole("button", { name: "Eliminar Calle 10 # 43-21" }));
      await user.click(within(confirmDialog()).getByRole("button", { name: "Cancelar" }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByText("Calle 10 # 43-21")).toBeInTheDocument();
      expect(onDelete).not.toHaveBeenCalled();
    });

    it("keeps the address listed and explains why when the delete fails", async () => {
      const user = userEvent.setup();
      renderBook({
        onDelete: vi.fn(
          async (): Promise<DeleteResult> => ({
            ok: false,
            status: 409,
            error: {
              code: "CONFLICT",
              message: "Address is used by a pending order",
              fields: null,
              reason: null,
              requestId: "req_del",
            },
          }),
        ),
      });

      await user.click(screen.getByRole("button", { name: "Eliminar Calle 10 # 43-21" }));
      await user.click(within(confirmDialog()).getByRole("button", { name: "Eliminar" }));

      const alert = await screen.findByRole("alert");
      // The CLOSED code against the catalogue. `error.message` is an English
      // log line and must never reach a customer.
      expect(alert).toHaveTextContent("Esta acción entra en conflicto con el estado actual.");
      expect(alert).not.toHaveTextContent("Address is used by a pending order");
      expect(screen.getByText("Calle 10 # 43-21")).toBeInTheDocument();
    });
  });
});
