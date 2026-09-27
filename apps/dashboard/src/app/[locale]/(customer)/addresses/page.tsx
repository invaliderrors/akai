import { getTranslations } from "next-intl/server";
import { createServerApiClient } from "@/lib/api/client";
import { createAccountApi } from "@/lib/account";
import {
  AddAddressButton,
  AddressBook,
  AddressBookProvider,
} from "@/components/account/address-book";
import { AccountErrorPanel } from "@/components/account/account-error-panel";
import { PageTemplate } from "@/components/shell/page-template";
import {
  createAddressAction,
  deleteAddressAction,
  updateAddressAction,
} from "../actions";

/**
 * `force-dynamic` because the address book is per-customer and read through the
 * session cookie: a cached render would serve one customer's addresses to the
 * next.
 */
export const dynamic = "force-dynamic";

export default async function AddressesPage() {
  const t = await getTranslations("account.addresses");
  const account = createAccountApi(await createServerApiClient());

  const addresses = await account.listAddresses();

  if (!addresses.ok) {
    return <AccountErrorPanel title={t("title")} error={addresses.error} />;
  }

  return (
    // The provider wraps the TEMPLATE, not the content: the header's prominent
    // action and the create sheet are siblings in `PageTemplate`'s layout, and
    // this is the one boolean they have to agree on. Everything inside it that
    // is not `AddressBook` stays a server-rendered subtree — `children` and
    // `actions` are elements created here, in a server component.
    <AddressBookProvider>
      <PageTemplate
        title={t("title")}
        description={t("subtitle")}
        width="reading"
        actions={<AddAddressButton />}
      >
        <AddressBook
          addresses={addresses.data}
          onCreate={createAddressAction}
          onUpdate={updateAddressAction}
          onDelete={deleteAddressAction}
        />
      </PageTemplate>
    </AddressBookProvider>
  );
}
