import { Clapperboard } from "lucide-react";
import { devLoginAction } from "@/app/actions/auth";

export default async function LoginPage() {
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
              <p className="text-sm text-stone-500">Standalone Phase 1 repo</p>
            </div>
          </div>

          <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Development auth only. Production OTP or Google OAuth is intentionally not wired in
            Phase 1.
          </div>

          <form action={devLoginAction} className="mt-6 grid gap-4">
            <div>
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                defaultValue="demo@sermonclipper.local"
                required
                className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
              />
            </div>

            <button
              type="submit"
              className="rounded-md bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800"
            >
              Enter dev workspace
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
