import React from "react";
import { useAuth, ALLOWED_DOMAINS } from "@/lib/auth";

/**
 * Shown when a visitor IS signed in but their verified email is not on the
 * company-domain allowlist. Offers a clean sign-out back to the sign-in page.
 * (Domain enforcement primarily happens server-side in the Google callback;
 * this is the client-side fallback.)
 */
const AccessRestricted = () => {
  const { user, logout } = useAuth();
  const email = user?.email || "";

  return (
    <div className="min-h-screen w-full grid place-items-center bg-[#fed7aa] px-4 py-10">
      <div className="bg-white border border-[#fdba74] rounded-2xl shadow-xl max-w-md w-full p-8 text-center">
        <img src="/brand/vivo-logo.png" alt="Vivo Fashion Group" className="h-10 mx-auto mb-5" />
        <h1 className="text-[18px] font-bold text-[#1a1a1a]">Access restricted</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-[#6b7280]">
          {email ? (
            <>
              The account{" "}
              <span className="font-semibold text-[#1a1a1a]">{email}</span>{" "}
              isn&apos;t authorized to use this dashboard.
            </>
          ) : (
            "This account isn't authorized to use this dashboard."
          )}
        </p>
        <p className="mt-2 text-[13px] text-[#6b7280]">
          Access is limited to{" "}
          {ALLOWED_DOMAINS.map((d, i) => (
            <span key={d}>
              {i > 0 && " and "}
              <span className="font-medium text-[#1a5c38]">@{d}</span>
            </span>
          ))}{" "}
          accounts.
        </p>
        <button
          type="button"
          onClick={logout}
          className="mt-6 inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-[#1a5c38] hover:bg-[#14492c] text-white text-[13px] font-semibold transition-colors"
          data-testid="access-restricted-signout"
        >
          Sign out
        </button>
      </div>
    </div>
  );
};

export default AccessRestricted;
