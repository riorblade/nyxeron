import { PrivyProvider, usePrivy, type User } from "@privy-io/react-auth";
import { LogIn } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { bsc } from "viem/chains";
import { Backdrop } from "@/components/Backdrop";
import { Brand } from "@/components/Brand";
import { Cta } from "@/components/Cta";
import { en } from "@/i18n/en";
import { useGame } from "@/store";
import { signedIn, useAccount, type Account } from "./account";
import { syncProfile } from "./remote";

const APP_ID = import.meta.env.VITE_PRIVY_APP_ID;
const t = en.auth;

/**
 * Everything past the landing page needs a signed-in player: email or Google only (so every player has an email),
 * with an embedded wallet on BNB Chain created at first sign-in. Loaded lazily, so the landing page stays light.
 * Without VITE_PRIVY_APP_ID (local dev) the game runs signed-out, as before.
 */
export default function AuthShell({ children }: { children: ReactNode }) {
  if (!APP_ID) return children;
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        loginMethods: ["email", "google"],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          showWalletUIs: false,
        },
        defaultChain: bsc,
        supportedChains: [bsc],
        appearance: {
          theme: "dark",
          accentColor: "#ffffff",
          landingHeader: t.modalTitle,
          walletChainType: "ethereum-only",
        },
      }}
    >
      <Gate>{children}</Gate>
    </PrivyProvider>
  );
}

const toAccount = (u: User): Account => ({
  id: u.id,
  email: u.email?.address ?? u.google?.email ?? "",
  wallet: u.wallet?.address ?? "",
  name: u.google?.name ?? "",
});

function Gate({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } =
    usePrivy();
  // Which Privy user the per-player stores are switched to (they switch before the game shows).
  const [scoped, setScoped] = useState("");

  useEffect(() => {
    useAccount.setState({ logout, token: getAccessToken });
  }, [logout, getAccessToken]);

  useEffect(() => {
    if (!authenticated || !user) return;
    const a = toAccount(user);
    if (scoped === a.id) {
      // Same player: keep the wallet fresh (the embedded wallet can arrive after sign-in).
      useAccount.setState({ account: a });
      return;
    }
    let live = true;
    void signedIn(a).then(() => {
      if (!live) return;
      setScoped(a.id);
      // The server's profile (name, avatar, wallet, portfolio, record) replaces this device's cache.
      void syncProfile();
    });
    return () => {
      live = false;
    };
  }, [authenticated, user, scoped]);

  if (!ready || (authenticated && scoped !== user?.id))
    return <Screen>{t.loading}</Screen>;
  if (!authenticated)
    return (
      <Screen>
        <h1 className="text-3xl font-medium tracking-[-0.02em]">{t.title}</h1>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-white/65">
          {t.why}
        </p>
        <Cta className="mt-6 w-56" onClick={login} autoFocus>
          <span className="flex items-center gap-2">
            <LogIn className="size-4" /> {t.signIn}
          </span>
        </Cta>
        <button
          className="mt-4 text-xs text-white/50 hover:text-white"
          onClick={() => useGame.getState().go("menu")}
        >
          ← {t.back}
        </button>
      </Screen>
    );
  return children;
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="fixed inset-0 flex items-center justify-center p-6">
      <Backdrop />
      <Brand
        className="absolute top-6 left-6 sm:left-10"
        onClick={() => useGame.getState().go("menu")}
      />
      <div className="glass enter relative flex w-full max-w-md flex-col items-center rounded-2xl p-8 text-center">
        {children}
      </div>
    </main>
  );
}
