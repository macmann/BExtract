import { historicalRuns } from "@/lib/results-data";
import RunInspectorClient from "./run-inspector-client";

export function generateStaticParams() {
  return historicalRuns.map((run) => ({ runId: run.id }));
}

export default async function RunInspectorPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <RunInspectorClient runId={runId} />;
}
