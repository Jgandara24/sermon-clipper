import { Clapperboard } from "lucide-react";
import { devLoginAction, requestEmailOtpAction, verifyEmailOtpAction } from "@/app/actions/auth";

function messageForError(error: string | undefined) {
  switch (error) {
    case "invalid-email":
      return "Enter a valid email address.";
    case "invalid-code":
      return "Enter the six-digit code from your email.";
    case "expired":
      return "That code expired. Request a new one.";
    case "too_many_attempts":
      return "Too many attempts. Request a new code.";
    case "otp_rate_limited":
      return "Too many sign-in code requests. Wait a few minutes and try again.";
    case "otp_delivery_failed":
      return "We could not send that sign-in code. Try again or contact support.";
    case "not_found":
      return "Request a new code before signing in.";
    case "dev-disabled":
      return "Development login is disabled in production.";
    default:
      return null;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; error?: string; next?: string; otp?: string }>;
}) {
  const params = await searchParams;
  const email = params.email ?? "demo@sermonclipper.local";
  const next = params.next?.startsWith("/") && !params.next.startsWith("//") ? params.next : "";
  const errorMessage = messageForError(params.error);
  const otpSent = params.otp === "sent";
  const showDevLogin = process.env.NODE_ENV !== "production";

  return (
    <main className="min-h-screen bg-[#f6f5f0] px-5 py-10 text-stone-950">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md items-center">
        <section className="w-full rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-teal-700 text-white">
              <Clapperboard size={22} aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Sermon Clipper</h1>
              <p className="text-sm text-stone-500">Church video clips, ready for review</p>
            </div>
          </div>

          {errorMessage ? (
            <div className="mt-6 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {errorMessage}
            </div>
          ) : null}

          <form action={requestEmailOtpAction} className="mt-6 grid gap-4">
            <div>
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                defaultValue={email}
                required
                className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
              />
            </div>
            <input type="hidden" name="next" value={next} />

            <button
              type="submit"
              className="rounded-md bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800"
            >
              Email me a sign-in code
            </button>
          </form>

          {otpSent ? (
            <form action={verifyEmailOtpAction} className="mt-6 grid gap-4 rounded-md border border-teal-100 bg-teal-50 p-4">
              <input type="hidden" name="email" value={email} />
              <input type="hidden" name="next" value={next} />
              <div>
                <label htmlFor="code" className="text-sm font-medium">
                  Six-digit code
                </label>
                <input
                  id="code"
                  name="code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 tracking-[0.35em] outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
                />
              </div>
              <button
                type="submit"
                className="rounded-md bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-stone-800"
              >
                Verify code
              </button>
              <p className="text-xs text-teal-900">
                Check your email for the code. Local development logs the code when SendGrid is not
                configured.
              </p>
            </form>
          ) : null}

          {showDevLogin ? (
            <form action={devLoginAction} className="mt-6 border-t border-stone-200 pt-5">
              <input type="hidden" name="email" value={email} />
              <input type="hidden" name="next" value={next} />
              <button
                type="submit"
                className="w-full rounded-md border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                Use development login
              </button>
            </form>
          ) : null}
        </section>
      </div>
    </main>
  );
}
