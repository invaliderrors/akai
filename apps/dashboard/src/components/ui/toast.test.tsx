import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TOAST_DWELL_MS,
  ToastProvider,
  useToast,
  type ToastOptions,
  type ToastTone,
} from "./toast";

interface HarnessProps {
  /** Shown one per press of "Mostrar", in order. */
  readonly queue: readonly ToastOptions[];
}

/**
 * A consumer, because the provider is the unit under test and `show()` only
 * exists on the far side of the context. Pressing "Mostrar" walks the queue, so
 * a test spells its scenario as data rather than as four bespoke buttons.
 */
function Harness({ queue }: HarnessProps) {
  const { show, dwellMs } = useToast();
  const [index, setIndex] = useState(0);

  return (
    <>
      <p>dwell {String(dwellMs)}</p>
      <button
        type="button"
        onClick={() => {
          const next = queue[index];
          if (next === undefined) return;
          show(next);
          setIndex(index + 1);
        }}
      >
        Mostrar
      </button>
    </>
  );
}

function renderToasts(queue: readonly ToastOptions[]) {
  return render(
    <ToastProvider closeLabel="Cerrar">
      <Harness queue={queue} />
    </ToastProvider>,
  );
}

function press() {
  fireEvent.click(screen.getByRole("button", { name: "Mostrar" }));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useToast", () => {
  it("throws outside a provider rather than swallowing the message", () => {
    function Orphan() {
      useToast();
      return null;
    }
    // React logs the thrown render error; silencing it keeps the run readable
    // without hiding the assertion, which is on the throw itself.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => render(<Orphan />)).toThrow(/ToastProvider/);

    logged.mockRestore();
  });

  it("exposes the dwell so copy can state it", () => {
    renderToasts([]);

    expect(screen.getByText(`dwell ${String(TOAST_DWELL_MS)}`)).toBeInTheDocument();
  });
});

describe("Toast roles", () => {
  it("interrupts for a failure and only for a failure", () => {
    renderToasts([{ tone: "danger", message: "No se pudo reenviar el correo." }]);
    press();

    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo reenviar el correo.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each<ToastTone>(["success", "warning", "progress"])(
    "announces a %s toast politely",
    (tone) => {
      renderToasts([{ tone, message: "Dirección eliminada." }]);
      press();

      expect(screen.getByRole("status")).toHaveTextContent("Dirección eliminada.");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
});

describe("Toast action", () => {
  it("runs the callback and takes the toast with it", () => {
    const onAction = vi.fn();
    renderToasts([
      { tone: "success", message: "Dirección eliminada.", action: { label: "Deshacer", onAction } },
    ]);
    press();

    fireEvent.click(screen.getByRole("button", { name: "Deshacer" }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("Toast queue", () => {
  it("shows at most three, newest at the bottom, and evicts the oldest", () => {
    renderToasts([
      { tone: "success", message: "Primero" },
      { tone: "success", message: "Segundo" },
      { tone: "success", message: "Tercero" },
      { tone: "success", message: "Cuarto" },
    ]);

    press();
    press();
    press();
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toEqual([
      "Primero",
      "Segundo",
      "Tercero",
    ]);

    press();
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toEqual([
      "Segundo",
      "Tercero",
      "Cuarto",
    ]);
  });
});

describe("Toast dwell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves on its own once the dwell is up", async () => {
    renderToasts([{ tone: "success", message: "Dirección eliminada." }]);
    press();

    await advance(TOAST_DWELL_MS - 1);
    expect(screen.getByRole("status")).toBeInTheDocument();

    await advance(2);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("never dismisses a failure, and gives it a named way out instead", async () => {
    renderToasts([{ tone: "danger", message: "No se pudo reenviar el correo." }]);
    press();

    await advance(TOAST_DWELL_MS * 3);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("pauses under the pointer and RESUMES rather than restarting", async () => {
    renderToasts([{ tone: "success", message: "Dirección eliminada." }]);
    press();
    const toast = screen.getByRole("status");

    await advance(4000);
    fireEvent.mouseOver(toast);

    // Well past the full dwell: a paused toast does not age.
    await advance(TOAST_DWELL_MS * 2);
    expect(screen.getByRole("status")).toBeInTheDocument();

    fireEvent.mouseOut(toast);
    // 4s were already spent, so 3.5s more must NOT be enough — that is the
    // difference between resuming and starting over.
    await advance(3500);
    expect(screen.getByRole("status")).toBeInTheDocument();

    await advance(1000);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("pauses while a keyboard user is inside the stack", async () => {
    renderToasts([
      {
        tone: "success",
        message: "Dirección eliminada.",
        action: { label: "Deshacer", onAction: vi.fn() },
      },
    ]);
    press();
    const undo = screen.getByRole("button", { name: "Deshacer" });

    act(() => {
      undo.focus();
    });
    await advance(TOAST_DWELL_MS * 2);
    expect(screen.getByRole("status")).toBeInTheDocument();

    act(() => {
      undo.blur();
    });
    await advance(TOAST_DWELL_MS + 100);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not strand the next toast when one is dismissed under the pointer", async () => {
    renderToasts([
      {
        tone: "success",
        message: "Dirección eliminada.",
        action: { label: "Deshacer", onAction: vi.fn() },
      },
      { tone: "success", message: "Dirección restaurada." },
    ]);
    press();
    fireEvent.mouseOver(screen.getByRole("status"));
    fireEvent.click(screen.getByRole("button", { name: "Deshacer" }));

    press();
    await advance(TOAST_DWELL_MS + 100);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
