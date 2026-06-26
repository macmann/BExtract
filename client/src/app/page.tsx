export default function Home() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-12 text-slate-950">
      <section className="mx-auto max-w-5xl rounded-3xl border border-slate-200 bg-white p-10 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-blue-600">BExtractor</p>
        <div className="mt-6 grid gap-8 md:grid-cols-[1.4fr_1fr] md:items-center">
          <div>
            <h1 className="text-4xl font-bold tracking-tight md:text-6xl">
              Enterprise document extraction, ready for Render.
            </h1>
            <p className="mt-6 text-lg leading-8 text-slate-600">
              A static Next.js workspace served by FastAPI from a single native Render web service,
              with API routes reserved under <code className="rounded bg-slate-100 px-2 py-1">/api</code>.
            </p>
          </div>
          <div className="rounded-2xl bg-slate-950 p-6 text-slate-100">
            <h2 className="text-lg font-semibold">Service layout</h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-300">
              <li>• Next.js static export in <code>client/out</code></li>
              <li>• FastAPI backend in <code>server/main.py</code></li>
              <li>• Prisma PostgreSQL schema at the repo root</li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}
