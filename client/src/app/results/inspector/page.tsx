"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import RunInspectorClient from "./run-inspector-client";

function ResultsInspectorContent() {
  const searchParams = useSearchParams();
  return <RunInspectorClient runId={searchParams.get("runId") || ""} />;
}

export default function ResultsInspectorPage() {
  return (
    <Suspense fallback={null}>
      <ResultsInspectorContent />
    </Suspense>
  );
}
